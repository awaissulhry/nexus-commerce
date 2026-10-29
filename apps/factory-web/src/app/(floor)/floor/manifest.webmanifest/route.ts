import { floorManifest } from '../../../../floor/install'

/**
 * The floor app's web app manifest (PLT-236: installed like an app): its own scope and start (`/floor`), full screen
 * on a tablet, landscape first. No service worker yet: the offline queue and the cache are B-W0-30's.
 */
export function GET() {
  return new Response(JSON.stringify(floorManifest()), { headers: { 'content-type': 'application/manifest+json; charset=utf-8', 'cache-control': 'public, max-age=3600' } })
}
