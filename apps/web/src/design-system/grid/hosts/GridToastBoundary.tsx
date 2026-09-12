'use client'

/**
 * GDS / PES.2 — the grid's toast boundary (programme ruling #22).
 *
 * ## The invariant
 *
 * **Adopting `design-system/grid` must never require the host to remember a provider.** A DS
 * component that white-screens a page because an optional context is missing has made the design
 * system a hazard to adopt, which is the opposite of its job.
 *
 * ## What actually happened
 *
 * `GridViewsMenu` calls `useToast()` to confirm a saved view. `useToast` throws when the DS
 * `ToastCtx` is absent (`components/Toast.tsx:62`) — and it IS absent on most routes, because the
 * root layout mounts a *legacy* Toast provider that does not populate the DS context. `/products/next`
 * only survives by privately mounting the DS provider itself. Moving the menu into the DS therefore
 * turned the Product Edit Studio into "Something went wrong" — measured in the browser, not reasoned
 * about, and it would have done the same to the next lane that adopted the menu.
 *
 * ## Why a provider here is safe
 *
 * The DS `ToastProvider` renders its viewport through `createPortal(..., document.body)`
 * (`Toast.tsx:44`), so nesting one inside another host's provider adds no layout, no stacking
 * context and no second visible region — the toasts simply land in the same corner. A host that
 * already provides one loses nothing; a host that does not, gains one.
 *
 * ## What this is NOT
 *
 * It is not a no-op shim. Ruling #22's hard constraint is that a silently swallowed toast is
 * forbidden — a notification that never appears is a silent failure, the same family as a disabled
 * control that cannot explain itself. So this mounts a REAL provider that really renders, rather
 * than making `useToast` return a function that does nothing.
 */
import { memo, type ReactNode } from 'react'

import { ToastProvider } from '../../components'

export const GridToastBoundary = memo(function GridToastBoundary({ children }: { children: ReactNode }) {
  return <ToastProvider>{children}</ToastProvider>
})
