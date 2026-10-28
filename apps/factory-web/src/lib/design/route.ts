/**
 * The local-only design index (`/design`, PLAN §3.1) is never part of a production build.
 *
 * Its route files are named `page.design.tsx` (and `layout.design.tsx` …). Next.js reads a route file only when its
 * extension is one of `pageExtensions`; `next.config.ts` adds `design.tsx` to that list ONLY for the development
 * server (`next dev`). `next build`, and therefore `next start`, never see these files as routes: the route does not
 * exist in production, it is not merely hidden. `scripts/factory/check-no-design-route.mjs` holds both halves: every
 * route file under `src/app/design/` carries the design extension, and a production build's manifests name no
 * `/design` route.
 */

/** Next.js's own default route-file extensions. */
export const PAGE_EXTENSIONS = ['tsx', 'ts', 'jsx', 'js'] as const

/** The extra extension the development server alone reads as a route file. */
export const DESIGN_PAGE_EXTENSIONS = ['design.tsx'] as const

/** The route-file extensions for a Next.js phase: the design extension only under `next dev`. */
export function pageExtensionsFor(developmentServer: boolean): string[] {
  return developmentServer ? [...PAGE_EXTENSIONS, ...DESIGN_PAGE_EXTENSIONS] : [...PAGE_EXTENSIONS]
}
