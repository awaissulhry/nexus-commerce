import type { NextConfig } from 'next'
import { readFactoryApiUrl } from './src/lib/api-url'

// `next dev`, `next build` and `next start` load this file: without FACTORY_API_URL none of them starts. The one
// exception is `next typegen` (the first half of `npm run typecheck`): it also loads this file, but only to read the
// route shapes, so type checking needs no API. It gets an address that cannot resolve and serves nothing.
const typegenOnly = process.argv.slice(2).includes('typegen')
const apiUrl = typegenOnly ? 'http://typegen.invalid' : readFactoryApiUrl(process.env.FACTORY_API_URL)

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Repository instructions live in the CLAUDE.md files; the dev server must not write its own.
  agentRules: false,
  // The browser talks to the factory API through this app, so the session cookie stays first-party.
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${apiUrl}/api/:path*` }]
  },
}

export default config
