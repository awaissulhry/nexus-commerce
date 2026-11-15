import { PUSH_WORKER_SOURCE } from '../../sw/push'

/**
 * The office's push service worker (B-W2b-388, src/sw/push.ts), at the web's root so its scope is the whole web. Sent fresh
 * every time (a new worker replaces the old one at once); it caches nothing.
 */
export function GET() {
  return new Response(PUSH_WORKER_SOURCE, {
    headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache, no-store', 'service-worker-allowed': '/' },
  })
}
