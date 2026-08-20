/**
 * Signed OAuth `state` — real CSRF protection for the connect flow.
 *
 * ── What this replaces, and why ──────────────────────────────────────────────
 *
 * The old scheme had two halves and neither worked:
 *
 *   • The SERVER issued a random hex string and, on callback, checked only
 *     `state.length >= 32`. Its own comment said "In production, validate state
 *     token against stored value" — it never did. Any 32-character string passed.
 *   • The BROWSER did the real check, comparing the callback's `state` against a
 *     value in `sessionStorage`.
 *
 * The browser half broke the moment the flow started opening eBay in a separate
 * window: `window.open` clones the opener's `sessionStorage` **at creation time**,
 * and the popup has to be created synchronously inside the click — before the
 * request that produces the state. So the popup's copy never contained it, and
 * every connect died with "State token mismatch - possible CSRF attack" on a
 * flow that was perfectly legitimate.
 *
 * ── The fix: make the state carry its own proof ──────────────────────────────
 *
 * `state` is now `<base64url(payload)>.<base64url(HMAC-SHA256(payload))>`. The
 * server issues it and the server verifies it, so:
 *
 *   • CSRF protection is real — a forged state fails the signature, and the
 *     check no longer depends on a length.
 *   • It is storage-free, so it does not care which tab or window the callback
 *     lands in. That whole class of bug is gone rather than patched.
 *   • It carries intent (`adoptConnectionId`) through the eBay round-trip
 *     **tamper-proof**, which is stronger than the `sessionStorage` value it
 *     replaces — a caller cannot rewrite which account a grant is adopted onto.
 *
 * The nonce keeps two states issued in the same millisecond distinct; `iat`
 * bounds the window. Replay inside that window is bounded by eBay itself: an
 * authorization code is single-use, so a replayed state carries a dead code.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes, matching the documented expiresIn

export interface OAuthStatePayload {
  /** Which channel this grant is for — a state minted for eBay cannot be replayed at another. */
  channel: string;
  /** Random per issue. */
  n: string;
  /** Issued-at, epoch ms. */
  iat: number;
  /** MAP.4 — "adopt this grant onto THAT connection", set by Reconnect. */
  adoptConnectionId?: string;
}

/**
 * Fail closed. A missing secret must not silently degrade to an unsigned state —
 * that is how a security control becomes decorative. Both of these are present
 * wherever the OAuth flow can actually run.
 */
function secret(): Buffer {
  const raw = process.env.NEXUS_CREDENTIAL_ENC_KEY || process.env.EBAY_CLIENT_SECRET;
  if (!raw) {
    throw new Error(
      "OAuth state signing needs NEXUS_CREDENTIAL_ENC_KEY (or EBAY_CLIENT_SECRET). Refusing to issue an unsigned state.",
    );
  }
  // Domain-separated so this key's use here can never collide with another.
  return createHmac("sha256", raw).update("nexus.oauth.state.v1").digest();
}

const b64url = (b: Buffer) => b.toString("base64url");

function sign(body: string): string {
  return b64url(createHmac("sha256", secret()).update(body).digest());
}

export function signOAuthState(input: { channel: string; adoptConnectionId?: string }): string {
  const payload: OAuthStatePayload = {
    channel: input.channel,
    n: randomBytes(16).toString("hex"),
    iat: Date.now(),
    ...(input.adoptConnectionId ? { adoptConnectionId: input.adoptConnectionId } : {}),
  };
  const body = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  return `${body}.${sign(body)}`;
}

export type StateFailure = "malformed" | "bad_signature" | "expired" | "wrong_channel";

/**
 * Deliberately NOT a discriminated union on `ok: true | false`.
 * `apps/api` compiles with `strict: false` (see reference_api_tsconfig_not_strict),
 * so the literal types widen to `boolean` and narrowing silently stops working —
 * callers then fail to compile on the very fields the union was meant to expose.
 */
export interface StateVerdict {
  ok: boolean;
  reason?: StateFailure;
  payload?: OAuthStatePayload;
}

export function verifyOAuthState(state: string | undefined, channel: string): StateVerdict {
  if (!state || typeof state !== "string") return { ok: false, reason: "malformed" };
  const dot = state.lastIndexOf(".");
  if (dot <= 0) return { ok: false, reason: "malformed" };

  const body = state.slice(0, dot);
  const given = state.slice(dot + 1);
  const expected = sign(body);

  // Constant-time compare. Lengths must match first — timingSafeEqual throws otherwise.
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "bad_signature" };

  let payload: OAuthStatePayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as OAuthStatePayload;
  } catch {
    return { ok: false, reason: "malformed" };
  }

  if (payload.channel !== channel) return { ok: false, reason: "wrong_channel" };
  if (!Number.isFinite(payload.iat) || Date.now() - payload.iat > MAX_AGE_MS) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, payload };
}
