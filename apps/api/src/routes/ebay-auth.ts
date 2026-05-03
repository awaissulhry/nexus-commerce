/**
 * eBay OAuth2 Authentication Routes
 * Handles user authorization, token exchange, and connection management
 */

import type { FastifyInstance } from "fastify";
import { randomBytes } from "crypto";
import prisma from "../db.js";
import { ebayAuthService } from "../services/ebay-auth.service.js";
import { logger } from "../utils/logger.js";

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
  app.post<{ Body: CallbackQueryParams & { state: string; connectionId: string } }>(
    "/api/ebay/auth/callback",
    async (request, reply) => {
      try {
        const { code, state, error, error_description, connectionId } = request.body;

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
        let sellerInfo = undefined;
        try {
          sellerInfo = await ebayAuthService.getSellerInfo(tokenData.access_token);
        } catch (error) {
          logger.warn("Failed to fetch seller info, continuing without it", { error });
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
