'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ApiClient } from '../../../../lib/api/client'
import { csvOf, downloadCsv, readProblem, writeProblem, type Notice, type WriteProblem } from '../../library/model'
import { setProperties } from '../properties/api'
import { readWhereUsed } from '../whereused/api'
import { decideApproval, readDepth } from './api'
import { depthCan, type MaterialApproval, type MaterialDepthActions, type MaterialDepthModel, type MaterialDepthView, type MaterialWhereUsedView, type PartRead } from './depth-model'

/**
 * B-W2b-238: the material record's depth (Properties & grades › Properties by kind, Compliance › Approval status, the Where
 * used tab), loaded while its tab shows and read again when the material's version moves (any write, ours or W1's).
 * One write at a time; a write moves the material's version, so the record reads the material again (`onMaterialMoved`)
 * and its own forms stay on the newest version.
 */
export function useMaterialDepth({
  api,
  materialId,
  version,
  tab,
  permissions,
  onMaterialMoved,
  csvWords,
}: {
  api: ApiClient
  materialId: string
  /** The material's version as the record holds it (null while it loads). */
  version: number | null
  tab: string
  permissions: readonly string[]
  onMaterialMoved: () => void
  /** The CSV's header and words (the container's translations). */
  csvWords: (key: string, params?: Record<string, string | number>) => string
}): { model: MaterialDepthModel; actions: MaterialDepthActions; reload: () => void } {
  const can = useMemo(() => depthCan(permissions), [permissions])
  const [depth, setDepth] = useState<PartRead<MaterialDepthView>>({ status: 'idle' })
  const [whereUsed, setWhereUsed] = useState<PartRead<MaterialWhereUsedView>>({ status: 'idle' })
  const [colourId, setColourId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [refused, setRefused] = useState<WriteProblem | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [offline, setOffline] = useState(false)
  const writing = useRef(false)
  const wantsDepth = tab === 'properties' || tab === 'compliance'
  const wantsWhereUsed = tab === 'whereused'

  useEffect(() => {
    const update = () => setOffline(typeof navigator !== 'undefined' && navigator.onLine === false)
    update()
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])

  const loadDepth = useCallback(() => {
    setDepth((current) => (current.status === 'ready' ? current : { status: 'loading' }))
    readDepth(api, materialId)
      .then((value) => setDepth({ status: 'ready', value }))
      .catch((error: unknown) => setDepth({ status: 'error', problem: readProblem(error) }))
  }, [api, materialId])

  const loadWhereUsed = useCallback(() => {
    setWhereUsed({ status: 'loading' })
    readWhereUsed(api, materialId, colourId)
      .then((value) => setWhereUsed({ status: 'ready', value }))
      .catch((error: unknown) => setWhereUsed({ status: 'error', problem: readProblem(error) }))
  }, [api, materialId, colourId])

  // The material's version is the dependency: a write anywhere reads the depth again (never during our own write).
  useEffect(() => {
    if (wantsDepth && version !== null && !writing.current) loadDepth()
  }, [wantsDepth, version, loadDepth])
  useEffect(() => {
    if (wantsWhereUsed && version !== null) loadWhereUsed()
  }, [wantsWhereUsed, version, loadWhereUsed])

  const write = async (run: (current: MaterialDepthView) => Promise<MaterialDepthView>, success: Notice): Promise<boolean> => {
    if (depth.status !== 'ready' || writing.current) return false
    writing.current = true
    setBusy(true)
    setRefused(null)
    try {
      const value = await run(depth.value)
      setDepth({ status: 'ready', value })
      setNotice(success)
      onMaterialMoved()
      return true
    } catch (error) {
      const problem = writeProblem(error)
      setRefused(problem)
      setNotice({ key: problem.key, tone: 'danger' })
      if (problem.reload) {
        loadDepth()
        onMaterialMoved()
      }
      return false
    } finally {
      writing.current = false
      setBusy(false)
    }
  }

  const exportRows = (lineIds: string[]) => {
    if (whereUsed.status !== 'ready') return
    const view = whereUsed.value
    const rows = view.rows.filter((row) => lineIds.includes(`${row.lineId}:${row.priority ?? 0}`))
    const csv = csvOf(
      ['csv.style', 'csv.revision', 'csv.status', 'csv.line', 'csv.role', 'csv.placement', 'csv.colours', 'csv.workOrders'].map((key) => csvWords(key)),
      rows.map((row) => [
        row.style.code,
        row.revision.revision,
        csvWords(`revisionStatus.${row.revision.status}`),
        row.seq,
        row.role === 'LINE' ? csvWords('role.LINE') : csvWords('role.ALTERNATE', { priority: row.priority ?? 0 }),
        row.placement ?? '',
        row.colour ? row.colour.code : row.colourways.map((entry) => `${entry.colourwayCode}: ${entry.colour.code}`).join(' · '),
        row.openWorkOrders === null ? '' : row.openWorkOrders.map((order) => order.number).join(' · '),
      ]),
    )
    downloadCsv(`${view.material.code}-where-used.csv`, csv)
  }

  const model: MaterialDepthModel = { can, depth, whereUsed, colourId, busy, offline, refused, notice }
  const actions: MaterialDepthActions = {
    onRetryDepth: loadDepth,
    onRetryWhereUsed: loadWhereUsed,
    onColour: setColourId,
    onDecide: (approval: MaterialApproval, note: string | null) =>
      write((current) => decideApproval(api, current.material, approval, note), { key: 'approval.notice.decided', tone: 'success', params: { approval } }),
    onSaveProperties: (properties) => write((current) => setProperties(api, current.material, properties), { key: 'properties.notice.saved', tone: 'success' }),
    onExport: exportRows,
    onDismissNotice: () => setNotice(null),
  }
  return {
    model,
    actions,
    reload: () => {
      if (wantsDepth) loadDepth()
      if (wantsWhereUsed) loadWhereUsed()
    },
  }
}
