// Single source of truth for the browser origins allowed to call this
// API — consumed by both the @fastify/cors registration (normal request
// lifecycle) and the SSE handlers, which write headers directly on the
// raw Node response and therefore bypass the cors plugin's onSend hook.

export const ALLOWED_WEB_ORIGINS = [
  'http://localhost:3000',
  'https://nexus-commerce-three.vercel.app',
  'https://nexus-commerce-web.vercel.app',
] as const

/** Echo-back the request Origin only if it's allow-listed (required for
 *  credentialed CORS, where '*' is not permitted). */
export function resolveAllowedOrigin(origin: string | undefined): string | null {
  return origin && (ALLOWED_WEB_ORIGINS as readonly string[]).includes(origin)
    ? origin
    : null
}
