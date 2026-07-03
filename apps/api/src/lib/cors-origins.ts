// Single source of truth for the browser origins allowed to call this
// API — consumed by both the @fastify/cors registration (normal request
// lifecycle) and the SSE handlers, which write headers directly on the
// raw Node response and therefore bypass the cors plugin's onSend hook.

// Extra origins from env (comma-separated), so adding a custom domain
// (e.g. https://app.xavia.it) at go-live is a config change, not a code
// edit. Example: NEXUS_WEB_ORIGINS="https://app.xavia.it,https://staging.xavia.it"
const ENV_WEB_ORIGINS = (process.env.NEXUS_WEB_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

export const ALLOWED_WEB_ORIGINS: string[] = [
  'http://localhost:3000',
  'https://nexus-commerce-three.vercel.app',
  'https://nexus-commerce-web.vercel.app',
  ...ENV_WEB_ORIGINS,
]

/** Echo-back the request Origin only if it's allow-listed (required for
 *  credentialed CORS, where '*' is not permitted). */
export function resolveAllowedOrigin(origin: string | undefined): string | null {
  return origin && ALLOWED_WEB_ORIGINS.includes(origin) ? origin : null
}
