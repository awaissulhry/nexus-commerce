import { readFactoryApiUrl } from '../../../lib/api-url'
import { forwardedForOf } from '../../../lib/api/forwarded'
import { proxyToApi } from '../../../lib/api/proxy'

/**
 * The browser's way to the factory API (B-W2b-F57; it replaces next.config.ts's rewrite): `/api/<route>` →
 * `<FACTORY_API_URL>/<route>`, so the session cookie stays first-party, with the browser's address in X-Forwarded-For
 * (lib/api/forwarded.ts) and everything else as the browser sent it (lib/api/proxy.ts).
 */

export const dynamic = 'force-dynamic'

function handle(request: Request): Promise<Response> {
  return proxyToApi(request, { apiUrl: readFactoryApiUrl(process.env.FACTORY_API_URL), forwardedFor: forwardedForOf(request.headers) })
}

export const GET = handle
export const POST = handle
export const PUT = handle
export const PATCH = handle
export const DELETE = handle
