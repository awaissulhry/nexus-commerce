/**
 * FC1 — one place that maps ChatError codes to HTTP statuses so every
 * /api/chat route degrades identically (guard.ts owns auth/CSRF; this owns
 * the service's domain refusals).
 */
import { NextResponse } from "next/server";
import { ChatError, type ChatErrorCode } from "./chat-service";

const STATUS: Record<ChatErrorCode, number> = {
  not_found: 404,
  not_member: 403,
  forbidden: 403,
  money_in_body: 400,
  invalid: 400,
};

/** returns a response for ChatError, or null so the route can rethrow unknowns */
export function chatErrorResponse(err: unknown): NextResponse | null {
  if (err instanceof ChatError) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: STATUS[err.code] });
  }
  return null;
}
