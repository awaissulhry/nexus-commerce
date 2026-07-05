/**
 * F1 — CSRF bootstrap: issues the double-submit cookie and returns the token
 * for the client to mirror in the x-factory-csrf header on mutations.
 */
import { NextResponse } from "next/server";
import { guarded, PUBLIC } from "@/lib/auth/guard";
import { csrfCookieHeader, newCsrfToken } from "@/lib/auth/session";

export const permission = PUBLIC;

export const GET = guarded(PUBLIC, async (req) => {
  const existing = req.cookies.get("factory_csrf")?.value;
  const token = existing ?? newCsrfToken();
  const res = NextResponse.json({ token });
  if (!existing) res.headers.append("Set-Cookie", csrfCookieHeader(token));
  return res;
});
