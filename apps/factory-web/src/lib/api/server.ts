import { cookies } from 'next/headers'
import { readFactoryApiUrl } from '../api-url'
import { API_COOKIES, createApiClient, type ApiClient } from './client'

/**
 * The client for server components and route handlers: straight to FACTORY_API_URL (no fallback: lib/api-url.ts), with
 * the request's own factory cookies forwarded — and no other cookie. Read-only by design: a server component never
 * writes; writes go from the browser, through the proxy, with the CSRF double submit.
 */
export async function serverApi(options: { company?: string | null } = {}): Promise<ApiClient> {
  const jar = await cookies()
  const cookie = API_COOKIES.flatMap((name) => {
    const value = jar.get(name)?.value
    return value === undefined ? [] : [`${name}=${value}`]
  }).join('; ')
  return createApiClient({
    baseUrl: readFactoryApiUrl(process.env.FACTORY_API_URL),
    company: options.company ?? null,
    cookie: cookie === '' ? null : cookie,
  })
}
