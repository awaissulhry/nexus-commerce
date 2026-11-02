'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ApiClient } from '../../../lib/api/client'
import { useOfficeScope } from '../../../shell/scope/scope-context'
import { useCoalesced } from '../_shared/hooks'
import { readProblem } from '../_shared/model'
import { callCounts } from '../calls/api'
import { getBundleTiles, getHeatCell, getHeatmap, getHourly, getStuck, getTargets, giveReason, setTargets, type BundleTiles, type HeatmapAnswer, type Hour, type HourlyAnswer, type LineTargets, type TrackedBundle } from './api'
import { boardRefusal, boardsLiveTouches, type FloorBoardsCan } from './model'

/** A section's read: its value, or why it failed; neither while the first read runs. */
export interface Read<T> {
  readonly value: T | null
  readonly problem: string | null
}

export interface BoardsState {
  readonly hourly: Read<readonly HourlyAnswer[]>
  readonly heat: Read<readonly HeatmapAnswer[]>
  readonly stuck: Read<readonly TrackedBundle[]>
  /** More open bundles than one read follows. */
  readonly stuckCapped: boolean
  readonly tiles: BundleTiles | null
  readonly openCalls: number | null
}

const NOTHING = { value: null, problem: null }

/**
 * Floor now's W2b reads (B-W2b-66): per site of the top bar's scope, hour by hour and the heat map (GET /production/boards/…),
 * the stuck bundles and their tile (production/bundles), the open help calls. A person without a section's permission
 * never reads it. Live: a burst of scans is one read at most every 10 seconds (the design's aggregation), a help call or a
 * reason reads its own part at once. Each write's refusal comes back in our words.
 */
export function useFloorBoards(api: ApiClient, can: FloorBoardsCan) {
  const scope = useOfficeScope()
  const siteIds = useMemo(() => (scope.siteId ? [scope.siteId] : scope.sites.map((site) => site.id)), [scope.siteId, scope.sites])
  const key = siteIds.join(',')
  const [hourly, setHourly] = useState<Read<readonly HourlyAnswer[]>>(NOTHING)
  const [heat, setHeat] = useState<Read<readonly HeatmapAnswer[]>>(NOTHING)
  const [stuck, setStuck] = useState<Read<readonly TrackedBundle[]> & { capped: boolean }>({ ...NOTHING, capped: false })
  const [tiles, setTiles] = useState<BundleTiles | null>(null)
  const [openCalls, setOpenCalls] = useState<number | null>(null)

  const loadHours = useCallback(() => {
    if (!can.boards) return
    Promise.all(siteIds.map((siteId) => getHourly(api, siteId)))
      .then((value) => setHourly({ value, problem: null }))
      .catch((error: unknown) => setHourly({ value: null, problem: readProblem(error) }))
  }, [api, can.boards, siteIds])

  const loadCalls = useCallback(() => {
    if (!can.calls) return
    callCounts(api, scope.siteId)
      .then((value) => setOpenCalls(value.tiles.OPEN))
      .catch(() => setOpenCalls(null))
  }, [api, can.calls, scope.siteId])

  const loadScanFed = useCallback(() => {
    loadHours()
    if (can.boards) {
      Promise.all(siteIds.map((siteId) => getHeatmap(api, siteId)))
        .then((value) => setHeat({ value, problem: null }))
        .catch((error: unknown) => setHeat({ value: null, problem: readProblem(error) }))
    }
    if (can.bundles) {
      getStuck(api, scope.siteId)
        .then((answer) => setStuck({ value: answer.bundles, problem: null, capped: answer.capped }))
        .catch((error: unknown) => setStuck({ value: null, problem: readProblem(error), capped: false }))
      getBundleTiles(api, scope.siteId)
        .then(setTiles)
        .catch(() => setTiles(null))
    }
  }, [api, can.boards, can.bundles, loadHours, scope.siteId, siteIds])

  const load = useCallback(() => {
    loadScanFed()
    loadCalls()
  }, [loadCalls, loadScanFed])

  useEffect(() => {
    load()
    // `key`: the same sites in a new array read nothing again.
  }, [key, can.boards, can.bundles, can.calls])

  const rereadScans = useCoalesced(loadScanFed, 10_000)
  const onLive = useCallback(
    (change: { type: string }) => {
      const touched = boardsLiveTouches(change)
      if (touched === 'scan') rereadScans()
      if (touched === 'calls') loadCalls()
      if (touched === 'hours') loadHours()
    },
    [loadCalls, loadHours, rereadScans],
  )

  const saveReason = useCallback(
    async (hour: Hour, draft: { code: string; note: string }): Promise<{ key: string; fix: string | null } | null> => {
      if (!hour.target) return null
      try {
        await giveReason(api, hour.target.id, { reasonCode: draft.code, version: hour.target.version, ...(draft.note.trim() ? { note: draft.note.trim() } : {}) })
        loadHours()
        return null
      } catch (error) {
        loadHours()
        return boardRefusal(error)
      }
    },
    [api, loadHours],
  )

  const readTargets = useCallback((lineId: string): Promise<LineTargets> => getTargets(api, lineId), [api])
  const saveTargets = useCallback(
    async (body: Parameters<typeof setTargets>[1]): Promise<{ key: string; fix: string | null } | null> => {
      try {
        await setTargets(api, body)
        loadHours()
        return null
      } catch (error) {
        return boardRefusal(error)
      }
    },
    [api, loadHours],
  )

  const readCell = useCallback((query: { siteId: string; lineId: string | null; code: string }) => getHeatCell(api, query), [api])

  const state: BoardsState = { hourly, heat, stuck, stuckCapped: stuck.capped, tiles, openCalls }
  return { state, load, onLive, saveReason, readTargets, saveTargets, readCell }
}
