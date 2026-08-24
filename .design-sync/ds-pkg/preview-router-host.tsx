/**
 * Preview-only: a Next App Router context host, exported from the DS bundle.
 *
 * `AccountSwitcher` calls `usePathname`/`useRouter`/`useSearchParams` at render.
 * Wrapping it from the preview file does NOT work: esbuild bundles a second copy
 * of Next's context module into the preview, so the preview's Provider and the
 * component's `useContext` read different context instances and the invariant
 * still throws. The host has to live in the same bundle as the component.
 *
 * Named with a leading underscore on purpose — component discovery matches
 * `^[A-Z][A-Za-z0-9]*$`, so this never becomes a card or a published contract.
 * It is a harness seam, not DS API.
 */
import type { ReactNode } from 'react'
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime'
import { PathnameContext, SearchParamsContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime'

const noop = () => {}
const stubRouter = { push: noop, replace: noop, refresh: noop, back: noop, forward: noop, prefetch: noop } as never

export function _PreviewRouterHost({
  children,
  pathname = '/',
  search = '',
}: { children: ReactNode; pathname?: string; search?: string }) {
  return (
    <AppRouterContext.Provider value={stubRouter}>
      <PathnameContext.Provider value={pathname}>
        <SearchParamsContext.Provider value={new URLSearchParams(search) as never}>
          {children}
        </SearchParamsContext.Provider>
      </PathnameContext.Provider>
    </AppRouterContext.Provider>
  )
}
