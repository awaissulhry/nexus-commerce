'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import type { Metric } from '@nexus/ui/components'
import { Skeleton } from '@nexus/ui/primitives'
import type { ApiClient } from '../../../../../lib/api/client'
import { useT } from '../../../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../../../lib/session/context'
import { liveMatches, useLive } from '../../../../quality/_shared/hooks'
import { LIST_MAX, listLots } from '../../../../quality/_shared/lots'
import type { LiveState } from '../../../../quality/_shared/model'
import { LOT_TILES, tileCounts, type LotTile, type TileCount } from '../../model'
import { listRequests } from '../../declarations/api'
import { listProfiles } from '../../profiles/api'
import { DEPTH_NAMESPACE, useDepthMetrics, ViewSwitch } from './parts'
import { activeDepthTile, DEPTH_COUNTS_UNKNOWN, DEPTH_COUNTS_UNREAD, DEPTH_TILE_FILTER, tileHref, type DepthCounts, type DepthTile, type LotsDepth, type TestsView } from './views'

/**
 * The containers' side of the page frame (B-W2b-267): the W2b tiles' counts (the declarations' and the profiles' own tile
 * counts — both reads answer them over every row, so each asks for its shortest filter), the Lot tests tiles on a W2b view
 * (W1's own two reads), live re-reads (coalesced), and what the Lot tests view (W1's container) mounts: the view switch, the
 * three W2b tiles and two ⋯ items ("Restricted substance list", "Test plan rules"). Reading needs compliance.certificates.view;
 * without it the W2b tiles are not shown at all.
 */

const DEPTH_EVENTS = ['compliance_material_tests.', 'compliance_substances.', 'supplier_document.']

async function readDepthCounts(api: ApiClient): Promise<DepthCounts> {
  const [declarations, profiles] = await Promise.all([listRequests(api, { shown: 'OVERDUE' }).catch(() => null), listProfiles(api, { state: 'BLOCKED' }).catch(() => null)])
  return {
    declarationsOverdue: declarations ? declarations.counts.overdue : null,
    rerequest: declarations ? declarations.counts.rerequest : null,
    profilesIncomplete: profiles ? profiles.counts.incomplete : null,
  }
}

/** The W2b tiles' counts, read once and again on the area's live changes (at most every 1.5 s). */
export function useDepthCounts(api: ApiClient, canView: boolean): { counts: DepthCounts; reread: () => void; live: LiveState } {
  const [counts, setCounts] = useState<DepthCounts>(DEPTH_COUNTS_UNREAD)
  const turn = useRef(0)
  const reread = useCallback(() => {
    if (!canView) {
      setCounts(DEPTH_COUNTS_UNKNOWN)
      return
    }
    const mine = ++turn.current
    void readDepthCounts(api).then((next) => {
      if (mine === turn.current) setCounts(next)
    })
  }, [api, canView])
  useEffect(() => reread(), [reread])
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const rereadRef = useRef(reread)
  rereadRef.current = reread
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), [])
  const live = useLive(
    (change) => {
      if (!canView || !liveMatches(change, DEPTH_EVENTS) || timer.current) return
      timer.current = setTimeout(() => {
        timer.current = null
        rereadRef.current()
      }, 1500)
    },
    () => rereadRef.current(),
  )
  return { counts, reread, live }
}

/** Where a tile goes: its view with its filter, or (pressed again) the view without it. */
export function tileTarget(prefix: string, tile: DepthTile, on: boolean): string {
  return on ? tileHref(prefix, tile) : `${prefix}/compliance/tests?view=${DEPTH_TILE_FILTER[tile].view}`
}


/** What the Lot tests view (W1's container) mounts of this step: one hook, its parts as data. */
export function useLotsDepth(prefix: string): LotsDepth {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const params = useSearchParams()
  const t = useT(DEPTH_NAMESPACE)
  const canView = session.permissions.includes('compliance.certificates.view')
  const { counts } = useDepthCounts(api, canView)
  const metrics = useDepthMetrics(counts, activeDepthTile(params), (tile, on) => router.push(tileTarget(prefix, tile, on), { scroll: false }))
  return useMemo(
    () => ({
      switcher: <ViewSwitch prefix={prefix} view="lots" />,
      tiles: canView ? metrics : [],
      more: [
        { id: 'depth-sep', separator: true },
        { id: 'substances', label: t('more.substances'), href: `${prefix}/compliance/tests?view=substances` },
        { id: 'plans', label: t('more.plans'), href: `${prefix}/compliance/tests?view=substances&part=plans` },
      ],
      keys: [{ keys: ['1', '2', '3', '4'], does: t('keys.views') }],
    }),
    [prefix, canView, metrics, t],
  )
}

const EMPTY_LOT_TILES: Record<LotTile, TileCount> = { onHold: { count: undefined, atLeast: false }, waiting: { count: undefined, atLeast: false }, failed: { count: undefined, atLeast: false }, released: { count: undefined, atLeast: false } }

/** W1's four lot tiles on a W2b view (the same two reads as the Lot tests view; a tile opens that view with its filter). */
export function useLotMetrics(prefix: string, canLots: boolean): Metric[] {
  const api = useOfficeApi()
  const router = useRouter()
  const t = useT('lab')
  const [tiles, setTiles] = useState<Record<LotTile, TileCount>>(EMPTY_LOT_TILES)
  useEffect(() => {
    if (!canLots) return
    let gone = false
    void Promise.all([listLots(api, { onHold: true, limit: LIST_MAX }).catch(() => null), listLots(api, { status: 'RELEASED', limit: LIST_MAX }).catch(() => null)]).then(([held, released]) => {
      if (!gone) setTiles(tileCounts(held, released))
    })
    return () => {
      gone = true
    }
  }, [api, canLots])
  if (!canLots) return []
  // A W2b view never has a lot filter pressed: a tile opens the Lot tests view with its saved filter.
  return LOT_TILES.map((id) => {
    const entry = tiles[id]
    const count = entry.count
    return {
      label: t(`tile.${id}`),
      value: count === undefined ? <Skeleton width={36} height={22} /> : count === null ? '—' : entry.atLeast ? t('tile.atLeast', { count }) : String(count),
      hint: count === null ? t('tile.unknown') : t(`tile.${id}Hint`, { max: LIST_MAX }),
      active: false,
      onClick: () => router.push(`${prefix}/compliance/tests?view=${id}`, { scroll: false }),
    }
  })
}

export type { LotsDepth, TestsView }
