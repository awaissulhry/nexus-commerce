/**
 * EPI2.1 — pure core of the preview pipeline. What may render INLINE is an
 * allowlist (XSS posture: SVG/HTML/Office never inline), cid: image sources
 * rewrite to our resolver route, and the remote-image counter feeds the
 * blocked-images notice (embedded cid/data images are not tracking pixels —
 * Gmail's model — so only remote http(s) images are gated).
 */

const INLINE_MIME: Record<string, "image" | "pdf"> = {
  "image/jpeg": "image",
  "image/jpg": "image",
  "image/png": "image",
  "image/gif": "image",
  "image/webp": "image",
  "image/bmp": "image",
  "application/pdf": "pdf",
};

export function previewKind(mimeType: string | null | undefined): "image" | "pdf" | "none" {
  if (!mimeType) return "none";
  const clean = mimeType.toLowerCase().split(";")[0].trim();
  return INLINE_MIME[clean] ?? "none";
}

/** rewrite `src="cid:…"` (sanitized html uses double quotes; singles tolerated) */
export function rewriteCidSources(html: string, urlFor: (cid: string) => string): string {
  return html.replace(/src=(["'])cid:([^"']+)\1/gi, (_m, q: string, cid: string) => `src=${q}${urlFor(cid)}${q}`);
}

/** remote images only — cid/data/relative sources don't count */
export function countRemoteImages(html: string): number {
  return (html.match(/<img[^>]+src=["']https?:/gi) ?? []).length;
}

/** MIME Content-ID headers wrap the id in angle brackets; match without them */
export function matchesContentId(headerValue: string | null | undefined, cid: string): boolean {
  if (!headerValue) return false;
  const norm = (v: string) => v.trim().replace(/^<|>$/g, "").toLowerCase();
  return norm(headerValue) === norm(cid);
}

/** filesystem-safe cache name for a Content-ID */
export function cidCacheName(cid: string): string {
  return cid.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "cid";
}
