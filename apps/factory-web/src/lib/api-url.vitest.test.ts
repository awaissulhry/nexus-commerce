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
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('refuses to load without FACTORY_API_URL', async () => {
    vi.stubEnv('FACTORY_API_URL', '')
    await expect(import('../../next.config')).rejects.toThrow(/FACTORY_API_URL is not set/)
  })

  it('lets only `next typegen` load without it, with an address that cannot resolve', async () => {
    vi.stubEnv('FACTORY_API_URL', '')
    const argv = process.argv
    process.argv = [argv[0] ?? 'node', 'next', 'typegen']
    try {
      const config = (await import('../../next.config')).default
      expect(await config.rewrites?.()).toEqual([{ source: '/api/:path*', destination: 'http://typegen.invalid/api/:path*' }])
    } finally {
      process.argv = argv
    }
  })

  it('proxies /api to the factory API when it is set', async () => {
    vi.stubEnv('FACTORY_API_URL', 'http://127.0.0.1:8190')
    const config = (await import('../../next.config')).default
    expect(await config.rewrites?.()).toEqual([{ source: '/api/:path*', destination: 'http://127.0.0.1:8190/api/:path*' }])
  })
})
