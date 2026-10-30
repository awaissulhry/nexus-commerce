'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { useOfficeApi } from '../../../../lib/session/context'
import { useLive } from '../../../_shared/buying/hooks'
import { editLineCapacity, editWorkCentreCapacity, listLanes, type Lane, type SiteLanes } from '../api'
import { readProblem, type TabHost } from '../model'
import { useEchoes, useMarks, useRowQueue } from './hooks'
import { bulkResult, laneKey, peopleEdit, percentEdit, refusalWords, type LaneField, type Notice, type Words } from './model'
import { EfficiencyView, type EfficiencyModel } from './view/EfficiencyView'

/**
 * Planning settings › Line efficiency (SCR-127, design sec:efficiency): reads the site's lines (with the last four weeks'
 * actual efficiency) and work centres (`GET /planning/lanes`), saves a lane's planned percent or its people per shift (a
 * headcount, never who) on its own at the version read (`PATCH /planning/lines/:id/capacity`,
 * `/planning/work-centres/:id/capacity`; a lane's writes wait for each other), and the same percent on several lanes.
 * Live `planning.capacity_changed` / `planning.settings_changed` of this site from someone else → Reload.
 */
export function EfficiencyTab({ host }: { host: TabHost }) {
  const api = useOfficeApi()
  const site = host.site
  const [load, setLoad] = useState<EfficiencyModel['load']>({ status: 'loading' })
  const [lanes, setLanes] = useState<SiteLanes | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [changedElsewhere, setChangedElsewhere] = useState(false)
  const [busy, setBusy] = useState(false)
  const { marks, setMark, fade, failedCount } = useMarks()
  const queue = useRowQueue()
  const echoes = useEchoes()
  const lanesRef = useRef<SiteLanes | null>(null)
  lanesRef.current = lanes
  const onStatus = host.onStatus

  const read = useCallback(async () => {
    try {
      setLanes(await listLanes(api, site.id))
      setLoad({ status: 'ready' })
      setChangedElsewhere(false)
    } catch (error) {
      setLoad({ status: 'error', problem: readProblem(error) })
    }
  }, [api, site.id])
  useEffect(() => {
    void read()
  }, [read])

  useLive(
    (change) => {
      if (change.fields.siteId !== site.id) return
      if (change.type === 'planning.capacity_changed') {
        if (echoes.isOurs(`${String(change.fields.laneKind)}:${String(change.fields.laneId)}`)) return
        setChangedElsewhere(true)
      } else if (change.type === 'planning.settings_changed') {
        // The site's default efficiency moves every lane without its own percent.
        setChangedElsewhere(true)
      }
    },
    () => void read(),
  )

  const laneNow = (key: string): Lane | null => {
    const now = lanesRef.current
    return now ? ([...now.lines, ...now.workCentres].find((lane) => laneKey(lane) === key) ?? null) : null
  }
  const put = (lane: Lane) =>
    setLanes((current) =>
      current
        ? {
            ...current,
            lines: current.lines.map((entry) => (laneKey(entry) === laneKey(lane) ? lane : entry)),
            workCentres: current.workCentres.map((entry) => (laneKey(entry) === laneKey(lane) ? lane : entry)),
          }
        : current,
    )

  /** One lane's write at its version now (after its earlier writes). */
  const write = (key: string, field: LaneField, value: string | number | null): Promise<{ ok: true } | { ok: false; words: Words; unknown: boolean }> =>
    queue(key, async () => {
      const lane = laneNow(key)
      if (!lane) return { ok: false as const, words: { key: 'ps.problem.gone' }, unknown: false }
      echoes.expect(key)
      const version = lane.capacity?.version
      try {
        const answer =
          lane.kind === 'LINE'
            ? await editLineCapacity(api, lane.id, { ...(version ? { version } : {}), ...(field === 'people' ? { operators: value as number | null } : { plannedEfficiencyPct: value as string }) }, newIdempotencyKey())
            : await editWorkCentreCapacity(api, lane.id, { ...(version ? { version } : {}), ...(field === 'people' ? { units: value as number | null } : { plannedEfficiencyPct: value as string }) }, newIdempotencyKey())
        put(answer.lane)
        return { ok: true as const }
      } catch (error) {
        const refusal = refusalWords(error)
        if (refusal.conflict) setChangedElsewhere(true)
        return { ok: false as const, words: refusal.words, unknown: refusal.unknown }
      }
    })

  return (
    <EfficiencyView
      model={{ prefix: host.prefix, site, can: host.can, load, lanes, marks, notice, changedElsewhere, busy }}
      actions={{
        onRetry: () => {
          setLoad({ status: 'loading' })
          void read()
        },
        onReload: () => void read(),
        onCell: (lane, field, raw) => {
          const key = laneKey(lane)
          const now = laneNow(key) ?? lane
          const edit = field === 'people' ? peopleEdit(now, raw) : percentEdit(now, raw)
          if (edit.kind === 'none') return
          if (edit.kind === 'refused') {
            setMark(key, field, { state: 'refused', problem: edit.words })
            return
          }
          setMark(key, field, { state: 'saving' })
          onStatus({ kind: 'saving' })
          void write(key, field, edit.value).then((outcome) => {
            if (outcome.ok) {
              setMark(key, field, { state: 'saved' })
              fade(key, field)
              onStatus({ kind: 'saved', at: new Date().toISOString() })
            } else {
              setMark(key, field, { state: outcome.unknown ? 'unknown' : 'refused', problem: outcome.words })
              onStatus({ kind: 'failed', count: failedCount + 1 })
            }
          })
        },
        onBulkPct: async (picked, value) => {
          setBusy(true)
          setNotice(null)
          let saved = 0
          const refused: { name: string; words: Words }[] = []
          for (const lane of picked) {
            const outcome = await write(laneKey(lane), 'plannedEfficiencyPct', value)
            if (outcome.ok) saved += 1
            else refused.push({ name: `${lane.code} · ${lane.name}`, words: outcome.words })
          }
          setBusy(false)
          setNotice(bulkResult(saved, refused))
          if (saved > 0) onStatus({ kind: 'saved', at: new Date().toISOString() })
          return true
        },
        onDismissNotice: () => setNotice(null),
      }}
    />
  )
}
