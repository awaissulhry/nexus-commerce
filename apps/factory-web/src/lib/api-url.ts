/**
 * The factory API's address for this web app. There is NO fallback: without FACTORY_API_URL the dev server, the
 * build and `next start` refuse to start (next.config.ts calls this), so the app can never quietly talk to a
 * production API. Locally it is the worktree's own API, for example http://127.0.0.1:8190.
 */
export function readFactoryApiUrl(value: string | undefined): string {
  if (value === undefined || value.trim() === '') {
    throw new Error(
      'FACTORY_API_URL is not set. The factory web has no default API: set it to your local factory API, for example ' +
        'FACTORY_API_URL=http://127.0.0.1:8190 npm run dev -w @nexus/factory-web',
    )
  }
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw new Error(`FACTORY_API_URL is not a URL: ${value}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`FACTORY_API_URL must be http or https, not ${url.protocol}`)
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new Error('FACTORY_API_URL must be a plain origin and path, without credentials, query or fragment')
  }
  return url.href.replace(/\/+$/, '')
}
