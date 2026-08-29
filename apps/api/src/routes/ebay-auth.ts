/**
 * eBay OAuth2 routes — CX.1 thin shims over the shared connect flow.
 *
 * The connect flow itself lives in `routes/cx-connect.routes.ts` +
 * `services/cx/oauth.service.ts` and is channel-agnostic: one `start`, one
 * browser-redirect callback on the API host, one `complete`. What remains here
 * is the legacy surface the web app still calls by its old name, each mapped
 * onto the shared service so there is exactly ONE implementation of the
 * state/PKCE/identity/placement rules.
 *
 * Retired (410 Gone): the browser-side `create-connection` + POST `callback`
 * pair. A callback that the BROWSER posts (with a connection id it minted
 * itself) was the shape that let a spoofed callback attach a grant to any row
 * (CX.0 audit S-8). eBay now redirects straight to `GET /api/cx/callback/ebay`.
 *
 * Retired (removed): `GET /connections`, `GET /connection/:id`, `POST /refresh`.
 * The first two returned token expiry + raw columns the Accounts panel already
 * gets from `/api/accounts`; `/refresh` is `POST /api/cx/connections/:id/refresh`.
 */

import type { FastifyInstance } from "fastify";
import { logger } from "../utils/logger.js";
import { ebayAuthService } from "../services/ebay-auth.service.js";
import { start as startOAuth, OAuthFlowError } from "../services/cx/oauth.service.js";
import { runHeartbeatFor } from "../jobs/cx-heartbeat.job.js";
import prisma from "../db.js";
import { CONNECTION_PUBLIC_SELECT } from "../services/connection-resolver.service.js";

const GONE = {
  success: false,
  code: "OAUTH_FLOW_MOVED",
  error:
    "This step no longer exists. eBay redirects to the API callback directly; " +
    "start a connection with POST /api/cx/connect/ebay/start.",
};

export async function ebayAuthRoutes(app: FastifyInstance) {
  /**
   * POST /api/ebay/auth/initiate — legacy name for `POST /api/cx/connect/ebay/start`.
   * Same contract as the shared route (authUrl + state + double-submit cookie);
   * kept so an older web bundle mid-deploy still gets a working popup.
   */
  app.post<{ Body?: { adoptConnectionId?: string; targetConnectionId?: string; intent?: string } }>(
    "/api/ebay/auth/initiate",
    async (request, reply) => {
      try {
        const body = request.body ?? {};
        const targetConnectionId = body.targetConnectionId ?? body.adoptConnectionId;
        const intent = (body.intent as "connect" | "reconnect" | "adopt" | undefined) ??
          (targetConnectionId ? "reconnect" : "connect");
        const userId = (request as unknown as { authUser?: { id?: string } }).authUser?.id;
        const started = await startOAuth({
          channelKey: "EBAY",
          intent,
          targetConnectionId,
          actor: { userId, kind: "operator" },
        });
        reply.setCookie(started.cookie.name, started.cookie.value, {
          path: "/api/cx/callback",
          httpOnly: true,
          secure: true,
          sameSite: "none",
          maxAge: started.cookie.maxAgeSec,
        });
        return reply.send({
          success: true,
          authUrl: started.authorizeUrl,
          state: started.state,
          expiresIn: started.expiresInSec,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const status = error instanceof OAuthFlowError ? error.status : 500;
        logger.error("Error initiating eBay auth", { error: message });
        return reply.status(status).send({ success: false, error: message, code: (error as { code?: string })?.code });
      }
    },
  );

  app.post("/api/ebay/auth/create-connection", async (_request, reply) => reply.status(410).send(GONE));
  app.post("/api/ebay/auth/callback", async (_request, reply) => reply.status(410).send(GONE));

  /**
   * POST /api/ebay/auth/revoke — revoke at eBay, null credentials, archive the row's grant.
   */
  app.post<{ Body: { connectionId?: string } }>("/api/ebay/auth/revoke", async (request, reply) => {
    try {
      const { connectionId } = request.body ?? {};
      if (!connectionId) {
        return reply.status(400).send({ success: false, error: "connectionId is required" });
      }
      await ebayAuthService.revokeTokens(connectionId);
      logger.info("eBay connection revoked", { connectionId });
      return reply.send({ success: true, message: "eBay connection revoked successfully" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("Error revoking eBay connection", { error: message });
      return reply.status(500).send({ success: false, error: message });
    }
  });

  /**
   * GET /api/ebay/auth/test?connectionId= — a REAL call to eBay, recorded as a
   * heartbeat (lastHeartbeatAt / authStatus move), not a token-format check.
   */
  app.get<{ Querystring: { connectionId?: string } }>("/api/ebay/auth/test", async (request, reply) => {
    try {
      const { connectionId } = request.query;
      if (!connectionId) {
        return reply.status(400).send({ success: false, error: "connectionId query parameter is required" });
      }
      const row = await prisma.channelConnection.findUnique({
        where: { id: connectionId },
        select: CONNECTION_PUBLIC_SELECT,
      });
      if (!row || row.channelType !== "EBAY") {
        return reply.status(404).send({ success: false, error: "eBay connection not found" });
      }
      const userId = (request as unknown as { authUser?: { id?: string } }).authUser?.id;
      const result = await runHeartbeatFor(row, { userId, kind: "operator" });
      if (!result.ok) {
        return reply.status(502).send({
          success: false,
          error: result.message ?? "eBay did not answer the heartbeat",
          authStatus: result.authStatus,
        });
      }
      const identity = (row.identity ?? {}) as { username?: string; storeName?: string; storeFrontUrl?: string };
      return reply.send({
        success: true,
        message: "eBay API connectivity test successful",
        authStatus: result.authStatus,
        checkedAt: new Date().toISOString(),
        seller: {
          signInName: identity.username ?? row.ebaySignInName ?? null,
          storeName: identity.storeName ?? row.ebayStoreName ?? null,
          storeFrontUrl: identity.storeFrontUrl ?? row.ebayStoreFrontUrl ?? null,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("eBay API connectivity test failed", { error: message });
      return reply.status(500).send({ success: false, error: message });
    }
  });
}
