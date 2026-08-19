/**
 * eBay OAuth2 Authentication Routes
 * Handles user authorization, token exchange, and connection management
 */

import type { FastifyInstance } from "fastify";
import { randomBytes } from "crypto";
import prisma from "../db.js";
import { ebayAuthService } from "../services/ebay-auth.service.js";
import { logger } from "../utils/logger.js";
import {
  findAccountByExternalId,
  countUnidentifiedAccounts,
} from "../services/connection-resolver.service.js";

/**
 * Request body for initiating eBay connection
 */
interface InitiateAuthBody {
  redirectUri: string;
}

/**
 * Request body for handling OAuth callback
 */
interface CallbackQueryParams {
  code?: string;
  state?: string;
  error?: string;
  error_description?: string;
}

/**
 * Request body for revoking connection
 */
interface RevokeConnectionBody {
  connectionId: string;
}

/**
 * Request body for getting connection status
 */
interface GetConnectionParams {
  connectionId: string;
}

export async function ebayAuthRoutes(app: FastifyInstance) {
  /**
   * POST /api/ebay/auth/create-connection
   * Creates a new ChannelConnection record for eBay
   * Called before initiating OAuth flow
   */
  app.post<{ Body: { channelType: string } }>(
    "/api/ebay/auth/create-connection",
    async (request, reply) => {
      try {
        const { channelType } = request.body;

        if (!channelType || channelType !== "EBAY") {
          return reply.status(400).send({
            success: false,
            error: "Invalid channel type",
          });
        }

        // Create new ChannelConnection
        const connection = await prisma.channelConnection.create({
          data: {
            channelType: "EBAY",
            isActive: false,
          },
        });

        logger.info("ChannelConnection created", {
          connectionId: connection.id,
          channelType: "EBAY",
        });

        return reply.status(201).send({
          success: true,
          connectionId: connection.id,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("Error creating ChannelConnection", { error: message });
        return reply.status(500).send({
          success: false,
          error: message,
        });
      }
    }
  );

  /**
   * POST /api/ebay/auth/initiate
   * Initiates the OAuth2 flow by generating authorization URL
   * Returns the URL where user should be redirected to authorize the app
   */
  app.post<{ Body: Partial<InitiateAuthBody> }>(
    "/api/ebay/auth/initiate",
    async (request, reply) => {
      try {
        // The body redirectUri is no longer used — the service reads
        // EBAY_RUNAME from env and uses it as the OAuth `redirect_uri`
        // query value (eBay requires the RuName, not the literal URL).
        // Body is accepted for backwards compat with the old frontend
        // but ignored.
        const state = randomBytes(32).toString("hex");
        const authUrl = ebayAuthService.generateAuthorizationUrl(state);

        logger.info("eBay OAuth2 authorization URL generated", {
          state: state.substring(0, 8) + "...",
        });

        return reply.send({
          success: true,
          authUrl,
          state, // Client should store this and send back in callback
          expiresIn: 600, // State token expires in 10 minutes
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("Error initiating eBay auth", { error: message });
        return reply.status(500).send({
          success: false,
          error: message,
        });
      }
    }
  );

  /**
   * POST /api/ebay/auth/callback
   * Handles the OAuth2 callback from eBay
   * Exchanges authorization code for access token and saves to database
   */
  app.post<{
    Body: CallbackQueryParams & {
      state: string;
      connectionId: string;
      /**
       * MAP.4 — "this grant is for THAT account, adopt it".
       *
       * The operator states which existing connection they are re-authorising.
       * Without it, a grant whose identity matches nothing cannot be told apart
       * from a genuinely new account, and guessing is how one account's tokens
       * end up on another account's row.
       */
      adoptConnectionId?: string;
    };
  }>(
    "/api/ebay/auth/callback",
    async (request, reply) => {
      try {
        const { code, state, error, error_description, connectionId, adoptConnectionId } = request.body;

        // Check for OAuth errors from eBay
        if (error) {
          logger.warn("eBay OAuth error", {
            error,
            error_description,
          });
          return reply.status(400).send({
            success: false,
            error: error_description || error,
          });
        }

        if (!code) {
          return reply.status(400).send({
            success: false,
            error: "Authorization code is required",
          });
        }

        if (!state) {
          return reply.status(400).send({
            success: false,
            error: "State parameter is required",
          });
        }

        if (!connectionId) {
          return reply.status(400).send({
            success: false,
            error: "connectionId is required",
          });
        }

        // Verify connection exists
        const connection = await prisma.channelConnection.findUnique({
          where: { id: connectionId },
        });

        if (!connection) {
          return reply.status(404).send({
            success: false,
            error: "ChannelConnection not found",
          });
        }

        // In production, validate state token against stored value
        // For now, we just check it's not empty
        if (!state || state.length < 32) {
          return reply.status(400).send({
            success: false,
            error: "Invalid state parameter",
          });
        }

        // Exchange code for tokens
        // @ts-ignore - request.body may contain redirectUri from callback
        // Service reads EBAY_RUNAME from env; second arg is unused
        // (kept for backwards compat with the old call shape).
        const tokenData = await ebayAuthService.exchangeCodeForToken(code);

        // Get seller information
        let sellerInfo: {
          signInName?: string;
          storeName?: string;
          storeFrontUrl?: string;
          externalAccountId?: string | null;
        } | undefined = undefined;
        try {
          sellerInfo = await ebayAuthService.getSellerInfo(tokenData.access_token);
        } catch (error) {
          logger.warn("Failed to fetch seller info, continuing without it", { error });
        }

        // ── MAP.4 — who consented, and is it someone we already hold? ──────
        const identity = await ebayAuthService.getSellerIdentity(tokenData.access_token);
        if (identity) {
          sellerInfo = {
            ...(sellerInfo ?? {}),
            // A real username finally replaces the "eBay seller (verified)"
            // placeholder this integration has shown since it shipped.
            signInName: identity.username,
            externalAccountId: identity.userId,
          };

          // Reconnecting an account we ALREADY have is the common case — a token
          // expiring, or an operator re-consenting for the new scope. It must
          // refresh that row, not mint a second one for the same seller.
          const already = await findAccountByExternalId("EBAY", identity.userId, connectionId);
          if (already) {
            await ebayAuthService.saveTokens(
              already.id,
              tokenData.access_token,
              tokenData.refresh_token || "",
              tokenData.expires_in,
              sellerInfo,
            );
            // The placeholder row this flow created up front is now surplus.
            await prisma.channelConnection.delete({ where: { id: connectionId } }).catch(() => {});
            logger.info("eBay re-consent folded into the existing account", {
              connectionId: already.id,
              username: identity.username,
            });
            // ⚠ The SAME response shape as the normal path below. The callback
            // page reads `result.connection.sellerName` unconditionally on any
            // 2xx, so an early return with a different shape crashes it with
            // "Cannot read properties of undefined" and reports Connection
            // Failed for a reconnect that actually SUCCEEDED. Measured on prod
            // 2026-08-19: the tokens were saved, the row was updated, and the
            // operator was told it failed.
            return reply.send({
              success: true,
              message: "eBay connection re-authorised",
              reconnected: true,
              connection: {
                id: already.id,
                channelType: "EBAY",
                isActive: true,
                sellerName: identity.username,
                storeName: sellerInfo?.storeName,
              },
            });
          }
          // No row carries this identity. Before minting a new account, check for
          // the migration case: a connection that predates the identity scope and
          // so has nothing to match on. Measured on prod 2026-08-19 — this is
          // exactly how the operator ended up with two ACTIVE rows for ONE eBay
          // account, and every eBay job then ran connections=2, doing its work
          // twice against the same seller until it was cleaned up.
          if (!already) {
            const unidentified = await countUnidentifiedAccounts("EBAY");
            if (unidentified > 0 && !adoptConnectionId) {
              await prisma.channelConnection.delete({ where: { id: connectionId } }).catch(() => {});
              return reply.status(409).send({
                success: false,
                error:
                  `This grant is for "${identity.username}", and no connected account carries that identity yet. ` +
                  `An existing eBay connection predates the identity permission, so the two cannot be told apart — ` +
                  `connecting now would create a duplicate of the same account. ` +
                  `If this IS that account, use Reconnect on it in Settings → Channels. ` +
                  `If it is a genuinely different account, reconnect the existing one first so it records its identity.`,
                code: "EBAY_IDENTITY_UNMATCHED",
                identity: identity.username,
              });
            }
          }

          // The operator named the account this grant belongs to. Adopt onto it:
          // that row owns the listings and orders, so moving the identity to the
          // data is zero movement, where moving the data to the identity is not.
          if (!already && adoptConnectionId) {
            const target = await prisma.channelConnection.findUnique({ where: { id: adoptConnectionId } });
            if (!target || target.channelType !== "EBAY") {
              return reply.status(400).send({ success: false, error: "adoptConnectionId is not an eBay connection" });
            }
            await ebayAuthService.saveTokens(
              target.id, tokenData.access_token, tokenData.refresh_token || "", tokenData.expires_in, sellerInfo,
            );
            await prisma.channelConnection.delete({ where: { id: connectionId } }).catch(() => {});
            logger.info("eBay grant adopted onto an existing connection", {
              connectionId: target.id, username: identity.username,
            });
            return reply.send({
              success: true,
              message: "eBay connection re-authorised",
              adopted: true,
              connection: {
                id: target.id, channelType: "EBAY", isActive: true,
                sellerName: identity.username, storeName: sellerInfo?.storeName,
              },
            });
          }
        } else {
          // No identity at all. Admitting a second unidentifiable account would
          // make two accounts we cannot tell apart — which is exactly what
          // ChannelConnection_active_account_key refuses at the database, and it
          // is better to say so here than to surface a P2002 after the operator
          // has already consented at eBay.
          const anyActive = await countUnidentifiedAccounts("EBAY");
          if (anyActive > 0) {
            await prisma.channelConnection.delete({ where: { id: connectionId } }).catch(() => {});
            return reply.status(409).send({
              success: false,
              error:
                "eBay did not return this account's identity, and an existing eBay account also has none — " +
                "the two cannot be told apart. Reconnect the existing account first so it picks up the " +
                "identity permission, then add this one.",
              code: "EBAY_IDENTITY_UNAVAILABLE",
            });
          }
        }

        // Save tokens to database
        await ebayAuthService.saveTokens(
          connectionId,
          tokenData.access_token,
          tokenData.refresh_token || "",
          tokenData.expires_in,
          sellerInfo
        );

        logger.info("eBay OAuth2 callback processed successfully", {
          connectionId,
          sellerName: sellerInfo?.signInName,
        });

        return reply.send({
          success: true,
          message: "eBay connection established successfully",
          connection: {
            id: connectionId,
            channelType: "EBAY",
            isActive: true,
            sellerName: sellerInfo?.signInName,
            storeName: sellerInfo?.storeName,
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("Error processing eBay auth callback", { error: message });
        return reply.status(500).send({
          success: false,
          error: message,
        });
      }
    }
  );

  /**
   * GET /api/ebay/auth/connections
   * List all eBay channel connections (active + inactive). The
   * /settings/channels UI consumes this to render the "Connected"
   * state after a successful OAuth flow. Sorted updatedAt desc so
   * the most recent connection wins if there are duplicates.
   */
  app.get("/api/ebay/auth/connections", async (_request, reply) => {
    try {
      const connections = await prisma.channelConnection.findMany({
        where: { channelType: "EBAY" },
        orderBy: { updatedAt: "desc" },
      });
      return reply.send({
        success: true,
        connections: connections.map((c) => ({
          id: c.id,
          channelType: c.channelType,
          isActive: c.isActive,
          sellerName: c.ebaySignInName,
          storeName: c.ebayStoreName,
          storeFrontUrl: c.ebayStoreFrontUrl,
          tokenExpiresAt: c.ebayTokenExpiresAt,
          lastSyncAt: c.lastSyncAt,
          lastSyncStatus: c.lastSyncStatus,
          lastSyncError: c.lastSyncError,
          createdAt: c.createdAt,
          updatedAt: c.updatedAt,
        })),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("Error listing connections", { error: message });
      return reply.status(500).send({
        success: false,
        error: message,
      });
    }
  });

  /**
   * GET /api/ebay/auth/connection/:connectionId
   * Get the status of an eBay connection
   */
  app.get<{ Params: GetConnectionParams }>(
    "/api/ebay/auth/connection/:connectionId",
    async (request, reply) => {
      try {
        const { connectionId } = request.params;

        const connection = await prisma.channelConnection.findUnique({
          where: { id: connectionId },
        });

        if (!connection) {
          return reply.status(404).send({
            success: false,
            error: "ChannelConnection not found",
          });
        }

        return reply.send({
          success: true,
          connection: {
            id: connection.id,
            channelType: connection.channelType,
            isActive: connection.isActive,
            sellerName: connection.ebaySignInName,
            storeName: connection.ebayStoreName,
            storeFrontUrl: connection.ebayStoreFrontUrl,
            tokenExpiresAt: connection.ebayTokenExpiresAt,
            lastSyncAt: connection.lastSyncAt,
            lastSyncStatus: connection.lastSyncStatus,
            lastSyncError: connection.lastSyncError,
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("Error fetching connection status", { error: message });
        return reply.status(500).send({
          success: false,
          error: message,
        });
      }
    }
  );

  /**
   * POST /api/ebay/auth/revoke
   * Revoke eBay connection and clear tokens
   */
  app.post<{ Body: RevokeConnectionBody }>(
    "/api/ebay/auth/revoke",
    async (request, reply) => {
      try {
        const { connectionId } = request.body;

        if (!connectionId) {
          return reply.status(400).send({
            success: false,
            error: "connectionId is required",
          });
        }

        // Revoke tokens
        await ebayAuthService.revokeTokens(connectionId);

        logger.info("eBay connection revoked", { connectionId });

        return reply.send({
          success: true,
          message: "eBay connection revoked successfully",
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("Error revoking eBay connection", { error: message });
        return reply.status(500).send({
          success: false,
          error: message,
        });
      }
    }
  );

  /**
   * POST /api/ebay/auth/refresh
   * Manually refresh eBay access token
   */
  app.post<{ Body: { connectionId: string } }>(
    "/api/ebay/auth/refresh",
    async (request, reply) => {
      try {
        const { connectionId } = request.body;

        if (!connectionId) {
          return reply.status(400).send({
            success: false,
            error: "connectionId is required",
          });
        }

        // Get valid token (will refresh if needed)
        const token = await ebayAuthService.getValidToken(connectionId);

        logger.info("eBay access token refreshed", { connectionId });

        return reply.send({
          success: true,
          message: "eBay access token refreshed successfully",
          token: token.substring(0, 20) + "...", // Return partial token for verification
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("Error refreshing eBay token", { error: message });
        return reply.status(500).send({
          success: false,
          error: message,
        });
      }
    }
  );

  /**
   * GET /api/ebay/auth/test
   * Test eBay API connectivity with current token
   */
  app.get<{ Querystring: { connectionId: string } }>(
    "/api/ebay/auth/test",
    async (request, reply) => {
      try {
        const { connectionId } = request.query;

        if (!connectionId) {
          return reply.status(400).send({
            success: false,
            error: "connectionId query parameter is required",
          });
        }

        // Get valid token
        const token = await ebayAuthService.getValidToken(connectionId);

        // Try to fetch seller info as a connectivity test
        const sellerInfo = await ebayAuthService.getSellerInfo(token);

        logger.info("eBay API connectivity test successful", {
          connectionId,
          sellerName: sellerInfo.signInName,
        });

        return reply.send({
          success: true,
          message: "eBay API connectivity test successful",
          seller: {
            signInName: sellerInfo.signInName,
            storeName: sellerInfo.storeName,
            storeFrontUrl: sellerInfo.storeFrontUrl,
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("eBay API connectivity test failed", { error: message });
        return reply.status(500).send({
          success: false,
          error: message,
        });
      }
    }
  );
}
