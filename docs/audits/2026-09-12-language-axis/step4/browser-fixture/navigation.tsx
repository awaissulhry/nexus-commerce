import React, { useSyncExternalStore, Suspense, lazy } from 'react'
// Match Next's reactive history integration, which Studio uses directly.
for (const method of ['pushState', 'replaceState'] as const) {
  const original = window.history[method].bind(window.history)
  window.history[method] = (...args) => { original(...args); window.dispatchEvent(new PopStateEvent('popstate')) }
}
const subscribe = (cb: () => void) => { window.addEventListener('popstate', cb); return () => window.removeEventListener('popstate', cb) }
const useUrl = () => useSyncExternalStore(subscribe, () => window.location.href)
export const usePathname = () => new URL(useUrl()).pathname
export const useSearchParams = () => new URL(useUrl()).searchParams
export const useParams = () => ({ id: 'cmokmy3a40078pm0p1fvnu523' })
export const notFound = () => { throw new Error('Fixture route unavailable') }
export const redirect = (url: string) => window.location.assign(url)
export const permanentRedirect = redirect
export const useSelectedLayoutSegment = () => null
export const useSelectedLayoutSegments = () => []
const move = (href: string, replace = false) => { window.history[replace ? 'replaceState' : 'pushState']({}, '', href); window.dispatchEvent(new PopStateEvent('popstate')) }
export const useRouter = () => ({ push: move, replace: (url: string) => move(url, true), refresh: () => window.location.reload(), prefetch: () => {} })
export function Link({ href, children, ...props }: any) { return <a {...props} href={href} onClick={e => { if (!e.ctrlKey && !e.metaKey) { e.preventDefault(); move(href) } }}>{children}</a> }
export function dynamic(load: any) { const Component = lazy(load); return (props: any) => <Suspense fallback={null}><Component {...props} /></Suspense> }
