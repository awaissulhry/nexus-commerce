import { color } from '@nexus/ui/tokens/colors'

/**
 * What makes the floor app installable (PLT-236; design floor.enrol "Install and check"): the web app manifest and a
 * placeholder icon in the design system's brand colours (the Owner's mark replaces it later). Plain data, so the
 * route handlers stay one line and a test reads it.
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
