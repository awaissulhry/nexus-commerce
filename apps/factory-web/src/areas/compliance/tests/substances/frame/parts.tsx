'use client'

import { useEffect, useRef, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { Tabs, type Metric } from '@nexus/ui/components'
import { Skeleton } from '@nexus/ui/primitives'
import { useT } from '../../../../../lib/i18n/provider'
import { QualityMessages } from '../../../../quality/_shared/parts'
import { isPageKey } from '../../../../quality/_shared/hooks'
import { DEPTH_TILES, viewHref, viewOfKey, TEST_VIEWS, type DepthCounts, type DepthTile, type TestsView } from './views'
import './depth.css'

/**
 * The parts of the Tests & substances page every view draws (B-W2b-267): the catalogues (the shared quality and lab words
 * with this step's `compliance-tests-depth`), the view switch (design sec:ts-views: link tabs, `?view=` in the address, keys
 * 1–4 while the focus is on the page) and the W2b tiles (design sec:ts-metrics: saved filters; a tile pressed shows its view
 * with the filter, pressed again clears it). Nothing here fetches.
 */

export const DEPTH_NAMESPACE = 'compliance-tests-depth'

/** The page's words: quality, lists, records, lab and this step's. */
export function DepthMessages({ children }: { children?: ReactNode }) {
  return <QualityMessages namespaces={['lab', DEPTH_NAMESPACE]}>{children}</QualityMessages>
}

/** Next's router, or null where none is mounted (a server render of a design case in a test). */
function useOptionalRouter(): ReturnType<typeof useRouter> | null {
  try {
    return useRouter()
  } catch {
    return null
  }
}

/** Lot tests · Supplier declarations · Material profiles · Substance list (link tabs; 1–4 switch from the page). */
export function ViewSwitch({ prefix, view }: { prefix: string; view: TestsView }) {
  const t = useT(DEPTH_NAMESPACE)
  const router = useOptionalRouter()
  const latest = useRef({ prefix, view, router })
  latest.current = { prefix, view, router }
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const next = viewOfKey(event.key)
      if (!next || !isPageKey(event)) return
      const now = latest.current
      if (next === now.view) return
      event.preventDefault()
      if (now.router) now.router.push(viewHref(now.prefix, next), { scroll: false })
      else window.location.assign(viewHref(now.prefix, next))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  return (
    <div className="fw-mt-switch">
      <Tabs
        ariaLabel={t('views.label')}
        tabs={TEST_VIEWS.map((id) => ({ id, label: t(`views.${id}`), href: viewHref(prefix, id) }))}
        active={view}
        overflow="scroll"
      />
    </div>
  )
}

/** The W2b tiles as DS metrics (a filter button each): the count, "—" with why when unknown, a skeleton while read. */
export function useDepthMetrics(counts: DepthCounts, active: DepthTile | null, onPick: (tile: DepthTile, on: boolean) => void): Metric[] {
  const t = useT(DEPTH_NAMESPACE)
  return DEPTH_TILES.map((tile) => {
    const count = counts[tile]
    return {
      label: t(`tile.${tile}`),
      value: count === undefined ? <Skeleton width={36} height={22} /> : count === null ? '—' : String(count),
      hint: count === null ? t('tile.unknown') : t(`tile.${tile}Hint`),
      active: active === tile,
      onClick: () => onPick(tile, active !== tile),
    }
  })
}
