/**
 * FP3.4 — public accept-link helper. The token IS the auth (no session): a
 * constant-time-ish sha256 lookup finds the quote.
 * EPQ.2 — notifyOwners moved to ./notify-owners (shared by manual actions,
 * the worker tick, and the public routes; supports excluding the actor).
 */
import { createHash } from "node:crypto";

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
