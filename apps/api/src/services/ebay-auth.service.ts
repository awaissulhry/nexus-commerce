import prisma from "../db.js";
import { logger } from "../utils/logger.js";

/**
 * eBay OAuth2 Token Response
 */
interface EbayTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
}

/**
 * eBay Auth Service
 * Handles OAuth2 authentication and token management for eBay seller accounts
 */
export class EbayAuthService {
  private clientId: string;
  private clientSecret: string;
  private ruName: string;
  private environment: "SANDBOX" | "PRODUCTION";
  // eBay splits its OAuth surface across TWO domains:
  //   - auth.ebay.com  → user-facing /oauth2/authorize page
  //   - api.ebay.com   → /identity/v1/oauth2/{token,revoke}, /sell/*
  // Sending the user to api.ebay.com/oauth/authorize returns 404; that
  // path doesn't exist. Keep them as separate fields so each consumer
  // hits the right host.
  private authBaseUrl: string;
  private apiBaseUrl: string;

  constructor() {
    this.clientId = process.env.EBAY_CLIENT_ID || "";
    this.clientSecret = process.env.EBAY_CLIENT_SECRET || "";
    // EBAY_RUNAME is the eBay-assigned alias that goes into the
    // OAuth `redirect_uri` query param AND the token-exchange body.
    // The actual destination URL where eBay sends the user lives in
    // the eBay developer console under that RuName ("Your auth
    // accepted URL"). Don't conflate the two — eBay will reject the
    // request if the literal URL is sent in `redirect_uri`.
    this.ruName = process.env.EBAY_RUNAME || "";
    this.environment = (process.env.EBAY_ENVIRONMENT as "SANDBOX" | "PRODUCTION") || "PRODUCTION";

    if (!this.clientId || !this.clientSecret) {
      logger.warn("eBay credentials not configured. OAuth2 flow will fail.");
    }
    if (!this.ruName) {
      logger.warn("EBAY_RUNAME not configured. OAuth2 flow will fail with 'unauthorized_client' from eBay.");
    }

    if (this.environment === "SANDBOX") {
      this.authBaseUrl = "https://auth.sandbox.ebay.com";
      this.apiBaseUrl = "https://api.sandbox.ebay.com";
    } else {
      this.authBaseUrl = "https://auth.ebay.com";
      this.apiBaseUrl = "https://api.ebay.com";
    }
  }

  /**
   * Generate OAuth2 authorization URL for user consent.
   * The `redirect_uri` query param must be the eBay RuName, not the
   * literal callback URL. eBay maps RuName → URL on its side using
   * the developer console config. The optional caller-provided URL
   * is ignored (kept in the signature for backwards compat with the
   * frontend that used to send it).
   */
  generateAuthorizationUrl(state: string, _redirectUriIgnored?: string): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      response_type: "code",
      redirect_uri: this.ruName,
      scope: [
        "https://api.ebay.com/oauth/api_scope",
        "https://api.ebay.com/oauth/api_scope/sell.account",
        "https://api.ebay.com/oauth/api_scope/sell.inventory",
        "https://api.ebay.com/oauth/api_scope/sell.fulfillment",
      ].join(" "),
      state,
    });

    return `${this.authBaseUrl}/oauth2/authorize?${params.toString()}`;
  }

  /**
   * Exchange authorization code for access token.
   * Same RuName rule as the auth URL: the token endpoint expects
   * the RuName in `redirect_uri`, not the literal callback URL.
   */
  async exchangeCodeForToken(code: string, _redirectUriIgnored?: string): Promise<EbayTokenResponse> {
    try {
      const response = await fetch(`${this.apiBaseUrl}/identity/v1/oauth2/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64")}`,
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: this.ruName,
        }).toString(),
      });

      if (!response.ok) {
        const error = await response.text();
        logger.error("eBay token exchange failed", { status: response.status, error });
        throw new Error(`Token exchange failed: ${response.statusText}`);
      }

      const data = (await response.json()) as EbayTokenResponse;
      logger.info("eBay token exchange successful");
      return data;
    } catch (error) {
      logger.error("Error exchanging code for token", { error });
      throw error;
    }
  }

  /**
   * Refresh an expired access token using refresh token
   * eBay refresh tokens are long-lived (typically 18 months)
   */
  async refreshAccessToken(refreshToken: string): Promise<EbayTokenResponse> {
    try {
      const response = await fetch(`${this.apiBaseUrl}/identity/v1/oauth2/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64")}`,
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        }).toString(),
      });

      if (!response.ok) {
        const error = await response.text();
        logger.error("eBay token refresh failed", { status: response.status, error });
        throw new Error(`Token refresh failed: ${response.statusText}`);
      }

      const data = (await response.json()) as EbayTokenResponse;
      logger.info("eBay token refreshed successfully");
      return data;
    } catch (error) {
      logger.error("Error refreshing access token", { error });
      throw error;
    }
  }

  /**
   * Get a valid access token for API calls
   * Automatically refreshes if token is expired or about to expire
   * This is the main method to use before making eBay API calls
   */
  async getValidToken(connectionId: string): Promise<string> {
    try {
      // Fetch the connection from database
      const connection = await prisma.channelConnection.findUnique({
        where: { id: connectionId },
      });

      if (!connection) {
        throw new Error(`ChannelConnection not found: ${connectionId}`);
      }

      if (!connection.ebayAccessToken || !connection.ebayRefreshToken) {
        throw new Error("eBay tokens not configured for this connection");
      }

      // Check if token is expired or about to expire (within 5 minutes)
      const now = new Date();
      const expiresAt = connection.ebayTokenExpiresAt;

      if (expiresAt && now.getTime() < expiresAt.getTime() - 5 * 60 * 1000) {
        // Token is still valid
        logger.debug("Using existing eBay access token", { connectionId });
        return connection.ebayAccessToken;
      }

      // Token is expired or about to expire, refresh it
      logger.info("eBay access token expired or expiring soon, refreshing", { connectionId });

      const newTokenData = await this.refreshAccessToken(connection.ebayRefreshToken);

      // Calculate new expiration time
      const newExpiresAt = new Date(Date.now() + newTokenData.expires_in * 1000);

      // Update the connection with new token
      const updated = await prisma.channelConnection.update({
        where: { id: connectionId },
        data: {
          ebayAccessToken: newTokenData.access_token,
          ebayRefreshToken: newTokenData.refresh_token || connection.ebayRefreshToken,
          ebayTokenExpiresAt: newExpiresAt,
          lastSyncAt: new Date(),
          lastSyncStatus: "SUCCESS",
        },
      });

      logger.info("eBay access token refreshed and saved", {
        connectionId,
        expiresAt: newExpiresAt,
      });

      return updated.ebayAccessToken!;
    } catch (error) {
      logger.error("Error getting valid eBay token", { connectionId, error });

      // Update connection with error status
      try {
        await prisma.channelConnection.update({
          where: { id: connectionId },
          data: {
            lastSyncStatus: "FAILED",
            lastSyncError: error instanceof Error ? error.message : "Unknown error",
          },
        });
      } catch (updateError) {
        logger.error("Failed to update connection error status", { updateError });
      }

      throw error;
    }
  }

  /**
   * Save tokens to database after successful OAuth2 flow
   */
  async saveTokens(
    connectionId: string,
    accessToken: string,
    refreshToken: string,
    expiresIn: number,
    sellerInfo?: {
      signInName?: string;
      storeName?: string;
      storeFrontUrl?: string;
    }
  ): Promise<void> {
    try {
      const expiresAt = new Date(Date.now() + expiresIn * 1000);

      await prisma.channelConnection.update({
        where: { id: connectionId },
        data: {
          ebayAccessToken: accessToken,
          ebayRefreshToken: refreshToken,
          ebayTokenExpiresAt: expiresAt,
          ebaySignInName: sellerInfo?.signInName,
          ebayStoreName: sellerInfo?.storeName,
          ebayStoreFrontUrl: sellerInfo?.storeFrontUrl,
          isActive: true,
          lastSyncAt: new Date(),
          lastSyncStatus: "SUCCESS",
        },
      });

      logger.info("eBay tokens saved successfully", {
        connectionId,
        expiresAt,
      });
    } catch (error) {
      logger.error("Error saving eBay tokens", { connectionId, error });
      throw error;
    }
  }

  /**
   * Revoke tokens and deactivate connection
   */
  async revokeTokens(connectionId: string): Promise<void> {
    try {
      const connection = await prisma.channelConnection.findUnique({
        where: { id: connectionId },
      });

      if (!connection || !connection.ebayAccessToken) {
        logger.warn("No tokens to revoke", { connectionId });
        return;
      }

      // Call eBay revocation endpoint
      try {
        const response = await fetch(`${this.apiBaseUrl}/identity/v1/oauth2/token/revoke`, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64")}`,
          },
          body: new URLSearchParams({
            token: connection.ebayAccessToken,
          }).toString(),
        });

        if (!response.ok) {
          logger.warn("eBay token revocation returned non-200 status", {
            status: response.status,
          });
        }
      } catch (error) {
        logger.warn("Error calling eBay revocation endpoint", { error });
        // Continue with local cleanup even if revocation fails
      }

      // Clear tokens from database
      await prisma.channelConnection.update({
        where: { id: connectionId },
        data: {
          ebayAccessToken: null,
          ebayRefreshToken: null,
          ebayTokenExpiresAt: null,
          isActive: false,
          lastSyncStatus: "SUCCESS",
          lastSyncError: null,
        },
      });

      logger.info("eBay tokens revoked and connection deactivated", { connectionId });
    } catch (error) {
      logger.error("Error revoking eBay tokens", { connectionId, error });
      throw error;
    }
  }

  /**
   * Probe a sell-scoped endpoint to confirm the access token is
   * valid. Returns the seller-registration / selling-limit payload
   * which is at least *something* the UI can display.
   *
   * Why this endpoint: the canonical "who is the authenticated
   * user?" call is /commerce/identity/v1/user, which requires the
   * `commerce.identity.readonly` OAuth scope. Our token only has
   * sell.* scopes, so identity returns 404. /sell/account/v1/privilege
   * works with the sell.account scope we already have. Doesn't
   * surface a username — see TECH_DEBT for the path to add identity
   * scope (requires re-authorising existing connections).
   */
  async getSellerInfo(accessToken: string): Promise<{
    signInName: string;
    storeName?: string;
    storeFrontUrl?: string;
  }> {
    try {
      const response = await fetch(`${this.apiBaseUrl}/sell/account/v1/privilege`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) {
        const error = await response.text();
        logger.error("Failed to fetch seller info from eBay", {
          status: response.status,
          error,
        });
        throw new Error(`Failed to fetch seller info: ${response.statusText}`);
      }

      const data = (await response.json()) as {
        sellerRegistrationCompleted?: boolean;
        sellingLimit?: {
          amount?: { value?: string; currency?: string };
          quantity?: number;
        };
      };

      // The privilege endpoint doesn't include a name. Surface a
      // meaningful placeholder so the UI doesn't render "Seller:
      // null" — the user still gets validation that the token works.
      // When we add the identity scope, this gets replaced with the
      // actual username.
      const signInName = data.sellerRegistrationCompleted
        ? "eBay seller (verified)"
        : "eBay seller";

      return { signInName };
    } catch (error) {
      logger.error("Error fetching seller info", { error });
      throw error;
    }
  }
}

// Export singleton instance
export const ebayAuthService = new EbayAuthService();
