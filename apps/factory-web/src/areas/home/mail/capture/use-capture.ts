'use client'

import { useEffect, useState } from 'react'
import type { ApiClient } from '../../../../lib/api/client'
import { readCapture } from '../../../admin/connections/mail-domain/capture/api'
import { captureProblem, type CaptureState } from './model'

/** Reads the company's capture address once for Home › Mail's "Copy capture address" (null: the person sends no mail). */
export function useCaptureAddress(api: ApiClient, companyId: string | null, enabled: boolean): CaptureState | null {
  const [state, setState] = useState<CaptureState>({ status: 'loading' })
  useEffect(() => {
    if (!enabled || !companyId) return
    const controller = new AbortController()
    readCapture(api, companyId, controller.signal)
      .then((read) => setState({ status: 'ready', address: read.capture?.address ?? null, receivingDomain: read.receivingDomain, mayManage: read.mayManage }))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setState({ status: 'error', problem: captureProblem(error) })
      })
    return () => controller.abort()
  }, [api, companyId, enabled])
  return enabled && companyId ? state : null
}
