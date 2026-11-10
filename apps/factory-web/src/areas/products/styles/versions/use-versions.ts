'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiClient } from '../../../../lib/api/client'
import { listOrders, listRequests, readCompare, readDrift } from '../../changes/api'
import { readProblem } from '../../changes/model'
import { readReleasedScope } from '../release/api'
import { readVersions } from './api'
import { pairIn, type ComparePair, type Read, type StyleChanges, type VersionsActions, type VersionsCan, type VersionsModel } from './model'

/** Each list of the style's changes reads at most this many (the API's page; a note says when more exist). */
const CHANGES_LIMIT = 50

/**
 * The Versions & changes tab's container (design products.styles style.versions): while the tab shows, or the Compare
 * revisions pop-up is open, it reads the style's revisions (B-W2b-220), the compare of the pair (the released revision
 * against the draft by default; the cost section priced for the page's company when the style is every company's), the
 * open quotes and orders on older revisions, the style's change requests and orders (B-W2b-226, with their own right) and
 * what the released revision is released for (B-W2b-231). Each part reads and fails alone; all are read again when the
 * style's revisions change (`loadKey`). Reads only: every write is the studio's (release, start, abandon) or Changes &
 * versions' own page.
 */
export function useVersions({
  api,
  styleId,
  companyId,
  tenantWide,
  me,
  can,
  enabled,
  loadKey,
  onWiden,
}: {
  api: ApiClient
  styleId: string
  /** The company the page works in (a tenant-wide style's cost is priced for it). */
  companyId: string | null
  tenantWide: boolean
  me: string
  can: VersionsCan
  /** The tab shows. */
  enabled: boolean
  /** Changes when a revision is started, released or abandoned. */
  loadKey: string | null
  onWiden: () => void
}): { model: VersionsModel | undefined; actions: VersionsActions; reload: () => void } {
  const [versions, setVersions] = useState<VersionsModel['versions']>({ status: 'idle' })
  const [pair, setPair] = useState<ComparePair | null>(null)
  const [compare, setCompare] = useState<VersionsModel['compare']>({ status: 'idle' })
  const [changes, setChanges] = useState<Read<StyleChanges>>({ status: 'idle' })
  const [drift, setDrift] = useState<VersionsModel['drift']>({ status: 'idle' })
  const [released, setReleased] = useState<VersionsModel['released']>({ status: 'idle' })
  const [compareOpen, setCompareOpen] = useState(false)
  const compareSeq = useRef(0)
  const active = can.read && (enabled || compareOpen)

  const loadVersions = useCallback(() => {
    if (!can.read) return
    setVersions((current) => (current.status === 'ready' ? current : { status: 'loading' }))
    readVersions(api, styleId)
      .then((value) => {
        setVersions({ status: 'ready', value })
        setPair((current) => pairIn(value.revisions, current))
      })
      .catch((error: unknown) => setVersions({ status: 'error', problem: readProblem(error) }))
  }, [api, styleId, can.read])

  const loadRest = useCallback(() => {
    if (can.read) {
      setDrift((current) => (current.status === 'ready' ? current : { status: 'loading' }))
      readDrift(api, styleId)
        .then((value) => setDrift({ status: 'ready', value }))
        .catch((error: unknown) => setDrift({ status: 'error', problem: readProblem(error) }))
    }
    setReleased((current) => (current.status === 'ready' ? current : { status: 'loading' }))
    readReleasedScope(api, styleId)
      .then((value) => setReleased({ status: 'ready', value }))
      .catch((error: unknown) => setReleased({ status: 'error', problem: readProblem(error) }))
    if (can.changes) {
      setChanges((current) => (current.status === 'ready' ? current : { status: 'loading' }))
      Promise.all([listRequests(api, { tile: 'ALL', styleId }, CHANGES_LIMIT), listOrders(api, { tile: 'ALL', styleId }, CHANGES_LIMIT)])
        .then(([requests, orders]) => setChanges({ status: 'ready', value: { requests: requests.rows, orders: orders.rows, complete: requests.complete && orders.complete } }))
        .catch((error: unknown) => setChanges({ status: 'error', problem: readProblem(error) }))
    }
  }, [api, styleId, can.read, can.changes])

  // The revisions (the compare's picker) while the tab or the pop-up shows; the tab's other parts while the tab shows.
  useEffect(() => {
    if (active) loadVersions()
  }, [active, loadKey, loadVersions])
  useEffect(() => {
    if (enabled) loadRest()
  }, [enabled, loadKey, loadRest])

  // The compare of the pair (the newest pick wins).
  const pairKey = pair ? `${pair.from}:${pair.to}` : null
  const loadCompare = useCallback(() => {
    if (!pair || !can.read) return
    const mine = ++compareSeq.current
    setCompare({ status: 'loading' })
    readCompare(api, { styleId, from: pair.from, to: pair.to, companyId: tenantWide && can.cost ? companyId : null })
      .then((value) => mine === compareSeq.current && setCompare({ status: 'ready', value }))
      .catch((error: unknown) => mine === compareSeq.current && setCompare({ status: 'error', problem: readProblem(error) }))
  }, [api, styleId, pairKey, can.read, can.cost, tenantWide, companyId])
  useEffect(() => {
    if (active && pair) loadCompare()
  }, [active, pairKey, loadKey, loadCompare])

  const reload = () => {
    if (active) loadVersions()
    if (enabled) loadRest()
    if (active && pair) loadCompare()
  }

  const actions: VersionsActions = {
    onPair: (next) => setPair(next),
    onSwap: () => setPair((current) => (current ? { from: current.to, to: current.from } : current)),
    onCompareOpen: (next) => {
      if (next) setPair(next)
      setCompareOpen(true)
    },
    onCompareClose: () => setCompareOpen(false),
    onRetry: (part) => {
      if (part === 'versions') loadVersions()
      else if (part === 'compare') loadCompare()
      else loadRest()
    },
    onWiden,
  }

  const model: VersionsModel | undefined = can.read
    ? { can, me, versions, pair, compare, changes: can.changes ? changes : null, drift, released, compareOpen }
    : undefined
  return { model, actions, reload }
}
