'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useConfirmFeedback } from '@nexus/ui/floor'
import { isApiError } from '../../lib/api/errors'
import { lookupHide, lookupLocation, lookupWorkOrder } from '../api'
import { zxingCamera } from '../camera'
import { useFloor, useFloorRouter } from '../FloorApp'
import { useFloorKeys } from '../keys'
import { lookupMachine } from '../tasks/machine/api'
import { lookupCarton } from '../tasks/scan/result/carton/api'
import { TASK_ROUTES } from '../tasks/routes'
import { cabinetOfScan, CABINET_PATH } from '../tasks/sds/model'
import { planScan, readScan, resultCode, resultType, type Lookup, type ScanResult } from './scan-model'
import { ScanView, type RecentScan } from './view/ScanView'

/**
 * The live SCR-024 (`/floor/scan`): each code read is planned (scan-model.ts: its type, this factory's tag, the
 * person's permissions), then the lookups it needs run in order and the first one that finds it answers. A badge
 * switches person. The recent list holds this person's own scans of this visit, newest first (never anyone else's).
 */

const MAX_RECENT = 5

export function FloorScan() {
  const store = useFloor()
  const router = useFloorRouter()
  const feedback = useConfirmFeedback()
  const { frame, onFrame } = store.frame('scan.title', { showHome: true })
  const [result, setResult] = useState<ScanResult | null>(null)
  const [loading, setLoading] = useState<string | null>(null)
  const [recent, setRecent] = useState<RecentScan[]>([])
  const taken = useRef(false)
  const { me, api, sessionEnded } = store

  const look = useCallback(
    async (code: string) => {
      if (!me) return
      // B-W2b-143: a cabinet's QR (its floor address) opens the cabinet's safety data sheets, also offline.
      const cabinet = cabinetOfScan(code)
      if (cabinet) return store.openWith(CABINET_PATH, cabinet)
      const read = readScan(code, me.scanTag)
      const plan = planScan(read, me.permissions)
      let found: ScanResult
      if (plan.kind === 'badge') {
        const problem = await store.switchTo(read.code)
        if (problem) {
          feedback('error')
          setResult({ kind: 'unknown', code: '', reason: 'badge' })
        }
        return
      }
      if (plan.kind === 'unknown') found = { kind: 'unknown', code: read.code, reason: plan.reason }
      else if (plan.kind === 'notOnFloor') found = { kind: 'notOnFloor', type: plan.type, code: read.code }
      else if (plan.kind === 'noPermission') found = { kind: 'noPermission', type: plan.type, code: read.code }
      // B-W2b-F16: a cut ticket away from Fabric cutting: what it is and where it is used.
      else if (plan.kind === 'cutTicket') found = { kind: 'cutTicket', code: read.code }
      // B-W2b-F17: a trolley's label away from the sewing line: what it is and where it is used.
      else if (plan.kind === 'trolley') found = { kind: 'trolley', code: read.code }
      else {
        setLoading(read.code)
        found = { kind: 'unknown', code: read.code, reason: 'notFound' }
        try {
          for (const lookup of plan.lookups) {
            const card = await run(lookup, read.code)
            if (card) {
              found = card
              break
            }
          }
        } catch (error) {
          if (isApiError(error) && error.kind === 'signed_out') return void sessionEnded()
          found = { kind: 'unavailable', code: read.code }
        } finally {
          setLoading(null)
        }
      }
      feedback(found.kind === 'hide' || found.kind === 'workOrder' || found.kind === 'location' || found.kind === 'machine' || found.kind === 'carton' ? 'success' : found.kind === 'notOnFloor' || found.kind === 'cutTicket' || found.kind === 'trolley' ? 'warning' : 'error')
      setResult(found)
      setRecent((current) => [{ code: resultCode(found) || read.code, type: resultType(found), at: new Date().toISOString() }, ...current].slice(0, MAX_RECENT))
    },
    [me, feedback, sessionEnded, store],
  )

  const run = (lookup: Lookup, code: string) => {
    switch (lookup) {
      case 'hide':
        return lookupHide(api, code)
      case 'workOrder':
        return lookupWorkOrder(api, code)
      case 'location':
        return lookupLocation(api, me!.site.id, code)
      case 'machine':
        return lookupMachine(api, code)
      case 'carton':
        return lookupCarton(api, code)
    }
  }

  // A code scanned on Home opens here with it.
  useEffect(() => {
    if (taken.current) return
    taken.current = true
    const code = store.takeScan()
    if (code) void look(code)
  }, [look, store])

  useFloorKeys({ escape: result ? () => setResult(null) : () => router.push('/floor') })

  if (!me) return null
  return (
    <ScanView
      model={{ frame, result, loading, recent, held: me.notice.blocksScans, canCut: me.permissions.includes('production.cut') && !me.notice.blocksScans, canReport: me.permissions.includes('plant.report'), canPack: me.permissions.includes('shipping.pack') && !me.notice.blocksScans }}
      onFrame={onFrame}
      onAction={(action) => {
        if (action.type === 'scan') return void look(action.code)
        if (action.type === 'clear') return setResult(null)
        if (action.type === 'home') return router.push('/floor')
        if (action.type === 'cut') return store.openWith(TASK_ROUTES.cut, action.code)
        // B-W2a-73: a machine's card opens the machine problem with its tag (never held by the notice: a safety report).
        if (action.type === 'report') return store.openWith(TASK_ROUTES.machine, action.code)
        // B-W2b-387: a carton's card opens its shipment at the packing bench (SCR-098 takes the marks' code).
        if (action.type === 'pack') return store.openWith(TASK_ROUTES.pack, action.code)
      }}
      camera={zxingCamera}
    />
  )
}
