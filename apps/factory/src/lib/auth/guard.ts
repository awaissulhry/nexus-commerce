/**
 * F1 — the deny-by-default route guard (S2 pattern shrunk to Next route
 * handlers). Every src/app/api route exports `permission` (string or
 * per-method map, or PUBLIC) and wraps its handlers in guarded() — the
 * coverage script (scripts/check-rbac-coverage.ts) fails the build on any
 * route missing either. FACTORY_RBAC_MODE=shadow logs would-be denials and
 * allows; =enforce denies with an audited 403. CSRF: double-submit cookie on
 * every mutation, PUBLIC included (protects login itself).
 */
import { NextRequest, NextResponse } from "next/server";
import { audit } from "@/lib/audit";
import { resolvePermissions, hasPermission, type Resolved } from "./rbac";
import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE, validateSessionToken, type SessionUser } from "./session";
import { stripFinancials } from "./strip-financials";

export const PUBLIC = "PUBLIC" as const;
export type Permission = string | typeof PUBLIC;

export type GuardContext = {
  params: Promise<Record<string, string>>;
  actor: SessionUser | null;
  resolved: Resolved | null;
};

type Handler = (req: NextRequest, ctx: GuardContext) => Promise<Response> | Response;

export const rbacMode = (): "shadow" | "enforce" =>
  process.env.FACTORY_RBAC_MODE === "enforce" ? "enforce" : "shadow";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function guarded(
  permission: Permission,
  handler: Handler,
  // EPQ.5 — csrf:"skip" is ONLY for signature-verified machine webhooks
  // (Stripe): they carry no cookies, so the double-submit cannot apply — the
  // HMAC signature over the raw body IS the anti-forgery proof, and the route
  // MUST verify it before doing anything. Never use on browser-called routes.
  opts?: { csrf?: "skip" },
) {
  return async (req: NextRequest, routeCtx: { params: Promise<Record<string, string>> }) => {
    if (MUTATING.has(req.method) && opts?.csrf !== "skip") {
      const cookie = req.cookies.get(CSRF_COOKIE)?.value;
      const header = req.headers.get(CSRF_HEADER);
      if (!cookie || !header || cookie !== header) {
        return NextResponse.json({ error: "CSRF check failed", code: "csrf_failed" }, { status: 403 });
      }
    }

    const token = req.cookies.get(SESSION_COOKIE)?.value;
    const actor = await validateSessionToken(token);
    const resolved = actor ? await resolvePermissions(actor) : null;
    const ctx: GuardContext = { params: routeCtx?.params ?? Promise.resolve({}), actor, resolved };

    if (permission !== PUBLIC) {
      if (!actor) {
        return NextResponse.json({ error: "Not signed in", code: "unauthenticated" }, { status: 401 });
      }
      if (!hasPermission(resolved!, permission)) {
        if (rbacMode() === "enforce") {
          void audit({
            actorId: actor.id,
            entityType: "auth",
            entityId: actor.id,
            action: "access.denied",
            after: { permission, method: req.method, path: req.nextUrl.pathname },
          });
          return NextResponse.json(
            { error: "Access denied", code: "forbidden", required: permission },
            { status: 403 },
          );
        }
        console.warn(
          `[rbac shadow] would deny ${actor.email} → ${permission} (${req.method} ${req.nextUrl.pathname})`,
        );
      }
    }

    return handler(req, ctx);
  };
}

/** JSON response with financial fields stripped for the caller's grains. */
export function jsonStripped(data: unknown, resolved: Resolved | null, init?: ResponseInit) {
  return NextResponse.json(stripFinancials(data, resolved), init);
}
