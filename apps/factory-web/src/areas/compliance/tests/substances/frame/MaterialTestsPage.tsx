'use client'

import { useMemo } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useOfficeApi, useOfficeSession } from '../../../../../lib/session/context'
import { DeclarationsPanel } from '../../declarations/DeclarationsPanel'
import { ProfilesPanel } from '../../profiles/ProfilesPanel'
import { SubstancesPanel } from '../SubstancesPanel'
import { DepthMessages, useDepthMetrics, ViewSwitch } from './parts'
import { tileTarget, useDepthCounts, useLotMetrics } from './use-depth'
import { activeDepthTile, type DepthView, type PageFrame } from './views'

/**
 * Compliance › Tests & substances, a W2b view (`?view=declarations|profiles|substances`; B-W2b-267): the page's frame —
 * W1's four lot tiles (quality.lots.view) and the three W2b tiles (compliance.certificates.view), the view switch — and the
 * view's own container. W1's LotsPage hands the page here when the address names a W2b view (one marked line).
 */
export function MaterialTestsPage({ view }: { view: DepthView }) {
  return (
    <DepthMessages>
      <Frame view={view} />
    </DepthMessages>
  )
}

function Frame({ view }: { view: DepthView }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const prefix = pathname.replace(/\/compliance\/tests\/?$/, '')
  const canView = session.permissions.includes('compliance.certificates.view')
  const canLots = session.permissions.includes('quality.lots.view')
  const { counts } = useDepthCounts(api, canView)
  const lotMetrics = useLotMetrics(prefix, canLots)
  const depthMetrics = useDepthMetrics(counts, activeDepthTile(params), (tile, on) => router.push(tileTarget(prefix, tile, on), { scroll: false }))
  const frame = useMemo<PageFrame>(() => ({ tiles: [...lotMetrics, ...(canView ? depthMetrics : [])], switcher: <ViewSwitch prefix={prefix} view={view} /> }), [lotMetrics, depthMetrics, canView, prefix, view])
  if (view === 'declarations') return <DeclarationsPanel frame={frame} />
  if (view === 'profiles') return <ProfilesPanel frame={frame} />
  return <SubstancesPanel frame={frame} />
}
