import prisma from "../db.js";
import { logger } from "../utils/logger.js";
import { recordApiCall } from "./outbound-api-call-log.service.js";

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
// CX.1 — delegation targets (see getValidToken / revokeTokens).
import { getAccessToken, revoke as cxRevoke, tokenServiceEnabled } from './cx/token.service.js';
import { SYSTEM_ACTOR } from './cx/events.service.js';

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
  generateAuthorizationUrl(
    state: string,
    _redirectUriIgnored?: string,
    opts?: {
      /**
       * Force eBay to show its sign-in page even when the browser already has an
       * eBay session.
       *
       * Without this, eBay silently re-authorises the account you are ALREADY
       * signed in as and redirects back in under a second — no login page, no
       * account chooser. Measured on prod 2026-08-19: that is why "connect
       * another account" appeared to do nothing, and why it kept handing back
       * the same seller. You cannot add a SECOND account without it unless you
       * first sign out of eBay or use a private window.
       */
      promptLogin?: boolean;
    },
  ): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      response_type: "code",
      redirect_uri: this.ruName,
      scope: [
        "https://api.ebay.com/oauth/api_scope",
        "https://api.ebay.com/oauth/api_scope/sell.account",
        "https://api.ebay.com/oauth/api_scope/sell.inventory",
        "https://api.ebay.com/oauth/api_scope/sell.fulfillment",
        // UM.9 — Promoted Listings (eBay Marketing API). Additive; takes
        // effect on the next operator re-authorization (existing tokens
        // keep their current scopes until re-consent).
        "https://api.ebay.com/oauth/api_scope/sell.marketing",
        // MAP.4 — seller IDENTITY. Load-bearing for multi-account: without it
        // eBay tells us nothing about WHO consented, `getSellerInfo` can only
        // return the literal "eBay seller (verified)", and two accounts are
        // indistinguishable. `ChannelConnection_active_account_key` keys on
        // externalAccountId, so an account we cannot identify cannot be admitted
        // alongside one we already hold.
        //
        // Additive, and takes effect on the NEXT authorization: existing tokens
        // keep their current scopes until the operator re-consents. So the
        // already-connected account keeps externalAccountId = NULL until it is
        // reconnected, and the settings page says so.
        "https://api.ebay.com/oauth/api_scope/commerce.identity.readonly",
      ].join(" "),
      state,
      ...(opts?.promptLogin ? { prompt: "login" } : {}),
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
      const data = await recordApiCall<EbayTokenResponse>(
        {
          channel: 'EBAY',
          operation: 'exchangeToken',
          endpoint: '/identity/v1/oauth2/token',
          method: 'POST',
          triggeredBy: 'api',
        },
        async () => {
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
            const errorBody = await response.text().catch(() => "");
            logger.error("eBay token exchange failed", { status: response.status, error: errorBody });
            const err = new Error(
              `eBay API error ${response.status}: ${errorBody.slice(0, 500)}`,
            ) as Error & { statusCode: number; body: string };
            err.statusCode = response.status;
            err.body = errorBody;
            throw err;
          }

          return (await response.json()) as EbayTokenResponse;
        },
      );
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
      const data = await recordApiCall<EbayTokenResponse>(
        {
          channel: 'EBAY',
          operation: 'refreshToken',
          endpoint: '/identity/v1/oauth2/token',
          method: 'POST',
          triggeredBy: 'api',
        },
        async () => {
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
            const errorBody = await response.text().catch(() => "");
            logger.error("eBay token refresh failed", { status: response.status, error: errorBody });
            const err = new Error(
              `eBay API error ${response.status}: ${errorBody.slice(0, 500)}`,
            ) as Error & { statusCode: number; body: string };
            err.statusCode = response.status;
            err.body = errorBody;
            throw err;
          }

          return (await response.json()) as EbayTokenResponse;
        },
      );
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
    // CX.1 — the token service is the only decryptor and the only refresher
    // (leased, rotation-aware, state-machine-backed). The legacy path below is
    // kept behind NEXUS_CX_TOKEN_SERVICE=0 for one release as the rollback.
    if (tokenServiceEnabled()) {
      return getAccessToken(connectionId);
    }
    try {
      // AS.3 — callers passed the whole connection row here for weeks (hidden
      // by `as any` prisma casts); the Prisma error it produced was cryptic
      // and per-tick-swallowed. Fail loud and precise instead.
      if (typeof connectionId !== "string" || !connectionId) {
        throw new Error(
          `getValidToken expects a connection id string, got ${typeof connectionId} — pass connection.id, not the row`,
        );
      }
      // Fetch the connection from database
      const connection = await prisma.channelConnection.findUnique({
        where: { id: connectionId },
      });

      if (!connection) {
        throw new Error(`ChannelConnection not found: ${connectionId}`);
      }

      // Generic-first read with legacy fallback. The H.2 migration
      // backfilled generic from legacy on existing rows; both sources
      // should agree, but if a future migration drops legacy first
      // this still works.
      const accessToken = connection.accessToken ?? connection.ebayAccessToken;
      const refreshToken = connection.refreshToken ?? connection.ebayRefreshToken;
      const expiresAt = connection.tokenExpiresAt ?? connection.ebayTokenExpiresAt;

      if (!accessToken || !refreshToken) {
        throw new Error("eBay tokens not configured for this connection");
      }

      // Check if token is expired or about to expire (within 5 minutes)
      const now = new Date();

      if (expiresAt && now.getTime() < expiresAt.getTime() - 5 * 60 * 1000) {
        // Token is still valid
        logger.debug("Using existing eBay access token", { connectionId });
        return accessToken;
      }

      // Token is expired or about to expire, refresh it
      logger.info("eBay access token expired or expiring soon, refreshing", { connectionId });

      const newTokenData = await this.refreshAccessToken(refreshToken);

      // Calculate new expiration time
      const newExpiresAt = new Date(Date.now() + newTokenData.expires_in * 1000);
      const newRefreshToken = newTokenData.refresh_token || refreshToken;

      // Dual-write: generic columns are the new home, legacy ebay*
      // columns stay populated for one release while callers migrate.
      // Clearing lastSyncError on SUCCESS so a stale error from a
      // previous failure doesn't keep showing in the UI alongside
      // a SUCCESS status (audit 2026-05-06 caught this drift).
      const updated = await prisma.channelConnection.update({
        where: { id: connectionId },
        data: {
          accessToken: newTokenData.access_token,
          refreshToken: newRefreshToken,
          tokenExpiresAt: newExpiresAt,
          ebayAccessToken: newTokenData.access_token,
          ebayRefreshToken: newRefreshToken,
          ebayTokenExpiresAt: newExpiresAt,
          lastSyncAt: new Date(),
          lastSyncStatus: "SUCCESS",
          lastSyncError: null,
        },
      });

      logger.info("eBay access token refreshed and saved", {
        connectionId,
        expiresAt: newExpiresAt,
      });

      return updated.accessToken ?? updated.ebayAccessToken!;
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
      /** MAP.4 — eBay's stable opaque user id, when the identity scope allowed it. */
      externalAccountId?: string | null;
    }
  ): Promise<void> {
    try {
      const expiresAt = new Date(Date.now() + expiresIn * 1000);

      // Dual-write: see getValidToken for rationale.
      await prisma.channelConnection.update({
        where: { id: connectionId },
        data: {
          accessToken,
          refreshToken,
          tokenExpiresAt: expiresAt,
          displayName: sellerInfo?.signInName,
          managedBy: "oauth",
          // MAP.4 — only written when we actually got one. Never overwrite a real
          // identity with null: a later token refresh without the scope must not
          // erase what a consented connect established.
          ...(sellerInfo?.externalAccountId
            ? { externalAccountId: sellerInfo.externalAccountId }
            : {}),
          ebayAccessToken: accessToken,
          ebayRefreshToken: refreshToken,
          ebayTokenExpiresAt: expiresAt,
          ebaySignInName: sellerInfo?.signInName,
          ebayStoreName: sellerInfo?.storeName,
          ebayStoreFrontUrl: sellerInfo?.storeFrontUrl,
          isActive: true,
          lastSyncAt: new Date(),
          lastSyncStatus: "SUCCESS",
          lastSyncError: null,
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
    if (tokenServiceEnabled()) {
      await cxRevoke(connectionId, SYSTEM_ACTOR, 'operator');
      return;
    }
    try {
      const connection = await prisma.channelConnection.findUnique({
        where: { id: connectionId },
      });

      // Generic-first read with legacy fallback.
      const accessToken = connection?.accessToken ?? connection?.ebayAccessToken;
      if (!connection || !accessToken) {
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
            token: accessToken,
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

      // Clear tokens from database — both generic and legacy.
      await prisma.channelConnection.update({
        where: { id: connectionId },
        data: {
          accessToken: null,
          refreshToken: null,
          tokenExpiresAt: null,
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

  /**
   * MAP.4 — who actually consented.
   *
   * `/sell/account/v1/privilege` (getSellerInfo above) carries no name, which is
   * why this codebase has been writing the placeholder "eBay seller (verified)"
   * since the eBay integration shipped. The Identity API does carry one, but it
   * needs the `commerce.identity.readonly` scope and it lives on the **apiz**
   * host, not `api.ebay.com` — a request to the wrong host 404s in a way that
   * looks like a missing scope.
   *
   * Returns null rather than throwing: a connection whose identity we could not
   * read is still a usable connection, it just cannot be told apart from another
   * one. The caller decides what that means (see the duplicate check in the OAuth
   * callback), and the settings page shows it as "identity unavailable —
   * reconnect to enable multi-account".
   */
  async getSellerIdentity(
    accessToken: string,
  ): Promise<{ userId: string; username: string } | null> {
    const base = process.env.EBAY_IDENTITY_BASE ?? "https://apiz.ebay.com";
    try {
      const response = await fetch(`${base}/commerce/identity/v1/user/`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      });
      if (!response.ok) {
        logger.warn("eBay identity unavailable", {
          status: response.status,
          hint:
            response.status === 403 || response.status === 404
              ? "token predates the commerce.identity.readonly scope — reconnect the account"
              : undefined,
        });
        return null;
      }
      const data = (await response.json()) as {
        userId?: string;
        username?: string;
      };
      if (!data?.userId && !data?.username) return null;
      // userId is eBay's stable opaque id; username is what the seller sees.
      // Prefer userId for identity because a username can be changed.
      return {
        userId: data.userId ?? data.username!,
        username: data.username ?? data.userId!,
      };
    } catch (error) {
      logger.warn("Error fetching eBay identity", { error });
      return null;
    }
  }
}

// Export singleton instance
export const ebayAuthService = new EbayAuthService();
