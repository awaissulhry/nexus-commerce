import type { NextConfig } from 'next'
import { PHASE_DEVELOPMENT_SERVER } from 'next/constants'
import { readFactoryApiUrl } from './src/lib/api-url'
import { pageExtensionsFor } from './src/lib/design/route'

/**
 * `next dev`, `next build` and `next start` call this function: without FACTORY_API_URL none of them starts. The one
 * exception is `next typegen` (the first half of `npm run typecheck`): it also loads this file, but only to read the
 * route shapes, so type checking needs no API. It gets an address that cannot resolve and serves nothing.
 */
export default function factoryWebConfig(phase: string): NextConfig {
  const typegenOnly = process.argv.slice(2).includes('typegen')
  const apiUrl = typegenOnly ? 'http://typegen.invalid' : readFactoryApiUrl(process.env.FACTORY_API_URL)
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
    // The browser talks to the factory API through this app (`/api/<route>` → `<FACTORY_API_URL>/<route>`), so the
    // session cookie stays first-party. The API's routes carry no `/api` prefix of their own.
    async rewrites() {
      return [{ source: '/api/:path*', destination: `${apiUrl}/:path*` }]
    },
  }
}
