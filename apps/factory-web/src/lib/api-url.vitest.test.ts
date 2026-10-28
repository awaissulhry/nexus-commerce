import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFactoryApiUrl } from './api-url'

describe('readFactoryApiUrl', () => {
  it.each([undefined, '', '   '])('refuses a missing value (%j): there is no fallback API', (value) => {
    expect(() => readFactoryApiUrl(value)).toThrow(/FACTORY_API_URL is not set/)
  })

  it.each([
    ['not a URL', 'factory-api:8190', /must be http or https|not a URL/],
    ['another protocol', 'ftp://127.0.0.1:8190', /must be http or https/],
    ['credentials', 'http://user:secret@127.0.0.1:8190', /plain origin/],
    ['a query', 'http://127.0.0.1:8190?x=1', /plain origin/],
  ])('refuses %s', (_label, value, message) => {
    expect(() => readFactoryApiUrl(value)).toThrow(message)
  })

  it('returns the address without a trailing slash', () => {
    expect(readFactoryApiUrl('http://127.0.0.1:8190/')).toBe('http://127.0.0.1:8190')
    expect(readFactoryApiUrl(' http://factory-api.railway.internal:8080 ')).toBe('http://factory-api.railway.internal:8080')
  })
})

describe('next.config.ts', () => {
  const DEV = 'phase-development-server'
  const BUILD = 'phase-production-build'
  const configFor = async (phase: string) => (await import('../../next.config')).default(phase)

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('refuses to start without FACTORY_API_URL', async () => {
    vi.stubEnv('FACTORY_API_URL', '')
    await expect(configFor(BUILD)).rejects.toThrow(/FACTORY_API_URL is not set/)
    await expect(configFor(DEV)).rejects.toThrow(/FACTORY_API_URL is not set/)
  })

  it('lets only `next typegen` load without it, with an address that cannot resolve', async () => {
    vi.stubEnv('FACTORY_API_URL', '')
    const argv = process.argv
    process.argv = [argv[0] ?? 'node', 'next', 'typegen']
    try {
      const config = await configFor(BUILD)
      expect(await config.rewrites?.()).toEqual([{ source: '/api/:path*', destination: 'http://typegen.invalid/:path*' }])
    } finally {
      process.argv = argv
    }
  })

  it('proxies /api/<route> to <FACTORY_API_URL>/<route> (the API has no /api prefix of its own)', async () => {
    vi.stubEnv('FACTORY_API_URL', 'http://127.0.0.1:8190')
    const config = await configFor(BUILD)
    expect(await config.rewrites?.()).toEqual([{ source: '/api/:path*', destination: 'http://127.0.0.1:8190/:path*' }])
  })

  it('reads `page.design.tsx` as a route only under `next dev`: /design never reaches a production build', async () => {
    vi.stubEnv('FACTORY_API_URL', 'http://127.0.0.1:8190')
    expect((await configFor(DEV)).pageExtensions).toEqual(['tsx', 'ts', 'jsx', 'js', 'design.tsx'])
    expect((await configFor(BUILD)).pageExtensions).toEqual(['tsx', 'ts', 'jsx', 'js'])
    expect((await configFor('phase-production-server')).pageExtensions).toEqual(['tsx', 'ts', 'jsx', 'js'])
  })

  it('compiles the design system from source', async () => {
    vi.stubEnv('FACTORY_API_URL', 'http://127.0.0.1:8190')
    expect((await configFor(BUILD)).transpilePackages).toEqual(['@nexus/ui'])
  })
})
