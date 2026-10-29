'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useConfirmFeedback } from '@nexus/ui/floor'
import { isApiError } from '../../lib/api/errors'
import { lookupHide, lookupLocation, lookupWorkOrder } from '../api'
import { zxingCamera } from '../camera'
import { useFloor } from '../FloorApp'
import { useFloorKeys } from '../keys'
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
  const router = useRouter()
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
      feedback(found.kind === 'hide' || found.kind === 'workOrder' || found.kind === 'location' ? 'success' : found.kind === 'notOnFloor' ? 'warning' : 'error')
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
      model={{ frame, result, loading, recent, held: me.notice.blocksScans }}
      onFrame={onFrame}
      onAction={(action) => {
        if (action.type === 'scan') return void look(action.code)
        if (action.type === 'clear') return setResult(null)
        if (action.type === 'home') return router.push('/floor')
      }}
      camera={zxingCamera}
    />
  )
}
