'use client'

/**
 * AL.1 — thin alias of the generic order-events-refresh hook,
 * kept here so the 12+ /insights sub-pages can import a name
 * that matches their domain.
 *
 * If you're adding a new live-refresh consumer outside /insights,
 * import the generic `useOrderEventsRefresh` from `@/hooks/...`
 * directly instead.
 */

export { useOrderEventsRefresh as useInsightsLiveRefresh } from '@/hooks/use-order-events-refresh'
