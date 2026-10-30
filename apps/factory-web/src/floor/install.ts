import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { color } from '@nexus/ui/tokens/colors'

/**
 * What makes the floor app installable (PLT-236; design floor.enrol "Install and check"): the web app manifest and a
 * placeholder icon in the design system's brand colours (the Owner's mark replaces it later). Plain data, so the
 * route handlers stay one line and a test reads it.
 *
 * And which version of the floor app this server serves (PLT-241, B-W2a-42 safe app updates): the floor layout writes
 * it into the page a tablet opens (the version that tablet RUNS), `/floor/version` answers it for the tablet's check
 * and for Admin › Devices ("outdated" when a tablet reports another one). Server only (it reads the build's id).
 */

export function floorManifest() {
  return {
    name: 'Nexus Factory · Floor',
    short_name: 'Nexus Floor',
    description: 'The factory floor app: scan, sign in with a badge, work at a station.',
    id: '/floor',
    start_url: '/floor',
    scope: '/floor',
    display: 'fullscreen',
    display_override: ['fullscreen', 'standalone'],
    orientation: 'landscape',
    background_color: color.bg,
    theme_color: color.primary,
    icons: [
      { src: '/floor/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
      { src: '/floor/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
    ],
  }
}

/** A square "F" on the brand blue, safe for a maskable crop (the mark sits in the middle 60%). */
export function floorIconSvg(): string {
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="Nexus Floor">',
    `<rect width="512" height="512" fill="${color.primary}"/>`,
    `<text x="256" y="256" dy="0.35em" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-size="280" font-weight="700" fill="${color.textInverse}">F</text>`,
    '</svg>',
  ].join('')
}

const MAX_VERSION = 40

/** The build's own id (`<dist>/BUILD_ID`, written by `next build`), or null under `next dev` or when it cannot be read. */
function buildId(): string | null {
  try {
    const id = readFileSync(join(process.cwd(), process.env.FACTORY_WEB_DIST_DIR || '.next', 'BUILD_ID'), 'utf8').trim()
    return id === '' ? null : id
  } catch {
    return null
  }
}

/**
 * The floor app's version: FACTORY_APP_VERSION when the deploy sets it (e.g. the commit), else the build's id, else
 * `dev` (a dev server). At most 40 characters (the API's device report takes no more). Read per request, never cached
 * in a client bundle: a tablet compares the version its page was served with against the server's current one.
 */
export function floorAppVersion(): string {
  const explicit = process.env.FACTORY_APP_VERSION?.trim()
  return (explicit || buildId() || 'dev').slice(0, MAX_VERSION)
}

/** `GET /floor/version`: the version, never cached. */
export function floorVersionResponse(): Response {
  return new Response(JSON.stringify({ version: floorAppVersion() }), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
}
