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
  private baseUrl: string;

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

    // Set base URL based on environment
    this.baseUrl =
      this.environment === "SANDBOX"
        ? "https://api.sandbox.ebay.com"
        : "https://api.ebay.com";
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

    return `${this.baseUrl}/oauth/authorize?${params.toString()}`;
  }

  /**
   * Exchange authorization code for access token.
   * Same RuName rule as the auth URL: the token endpoint expects
   * the RuName in `redirect_uri`, not the literal callback URL.
   */
  async exchangeCodeForToken(code: string, _redirectUriIgnored?: string): Promise<EbayTokenResponse> {
    try {
      const response = await fetch(`${this.baseUrl}/identity/v1/oauth2/token`, {
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
      const response = await fetch(`${this.baseUrl}/identity/v1/oauth2/token`, {
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
        const response = await fetch(`${this.baseUrl}/identity/v1/oauth2/token/revoke`, {
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
   * Get seller information from eBay API
   * Requires valid access token
   */
  async getSellerInfo(accessToken: string): Promise<{
    signInName: string;
    storeName?: string;
    storeFrontUrl?: string;
  }> {
    try {
      const response = await fetch(`${this.baseUrl}/sell/account/v1/seller`, {
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

      const data = (await response.json()) as any;

      return {
        signInName: data.username || data.email || "Unknown",
        storeName: data.storeName,
        storeFrontUrl: data.storeFrontUrl,
      };
    } catch (error) {
      logger.error("Error fetching seller info", { error });
      throw error;
    }
  }
}

// Export singleton instance
export const ebayAuthService = new EbayAuthService();
