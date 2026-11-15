import type { NextConfig } from 'next'
import { PHASE_DEVELOPMENT_SERVER } from 'next/constants'
import { readFactoryApiUrl } from './src/lib/api-url'
import { readWebTrustedProxies } from './src/lib/api/forwarded'
import { pageExtensionsFor } from './src/lib/design/route'

/**
 * `next dev`, `next build` and `next start` call this function: without FACTORY_API_URL none of them starts. The one
 * exception is `next typegen` (the first half of `npm run typecheck`): it also loads this file, but only to read the
 * route shapes, so type checking needs no API.
 * B-W2b-F57: nor does any of them start with a FACTORY_TRUSTED_PROXIES that is not valid, or on Railway without it (the
 * edges in front of this web: lib/api/forwarded.ts).
 */
export default function factoryWebConfig(phase: string): NextConfig {
  const typegenOnly = process.argv.slice(2).includes('typegen')
  if (!typegenOnly) {
    readFactoryApiUrl(process.env.FACTORY_API_URL)
    readWebTrustedProxies(process.env.FACTORY_TRUSTED_PROXIES, process.env.RAILWAY_ENVIRONMENT)
  }
  return {
    reactStrictMode: true,
    poweredByHeader: false,
    // Repository instructions live in the CLAUDE.md files; the dev server must not write its own.
    agentRules: false,
    // A check build beside a running dev server writes elsewhere (FACTORY_WEB_DIST_DIR=.next-check); unset: `.next`.
    ...(process.env.FACTORY_WEB_DIST_DIR ? { distDir: process.env.FACTORY_WEB_DIST_DIR } : {}),
    // The design system is TypeScript source (packages/ui): this app compiles it, as the Commerce web does.
    transpilePackages: ['@nexus/ui'],
    // `/design` (the local design index) exists only under `next dev`: src/lib/design/route.ts.
    pageExtensions: pageExtensionsFor(phase === PHASE_DEVELOPMENT_SERVER),
    // B-W2b-F6 (floor/moves.ts): a floor tablet keeps the pages it prefetched whole for a day, and a move with the network gone
    // waits instead of falling back to a full page load, which ends on the browser's error page.
    experimental: { staleTimes: { static: 86_400 }, useOffline: true },
    // B-W2b-F57: the browser talks to the factory API through this app's route `src/app/api/[...path]/route.ts`
    // (`/api/<route>` → `<FACTORY_API_URL>/<route>`, the session cookie first-party), no longer a rewrite: a rewrite cannot
    // tell the API whose call it is (lib/api/forwarded.ts). The API's routes carry no `/api` prefix of their own.
  }
}
