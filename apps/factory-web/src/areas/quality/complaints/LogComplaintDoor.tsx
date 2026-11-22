'use client'

import { useEffect, useMemo, useRef } from 'react'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { complaintsCan, romeToday } from './model'
import { useLogComplaint, type LogComplaintSeed } from './use-log-complaint'
import { ComplaintsMessages } from './view/parts'
import { LogComplaintModal } from './view/LogComplaintModal'

/**
 * F-OS-303 (order SHIPMENTS tab) — Quality › Complaints' OWN Log complaint, opened in place for one customer, order and (from a
 * shipment's row) that shipment: the extracted hook and the same LogComplaintModal, mounted only while open. Logged, the opener says
 * where it went; Cancel closes it.
 */
export function LogComplaintDoor({ seed, companyId, prefix, onLogged, onClose }: { seed: LogComplaintSeed; companyId: string; prefix: string; onLogged: (complaint: { readonly id: string; readonly number: string }, failedPhotos: number) => void; onClose: () => void }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const can = useMemo(() => complaintsCan(session.permissions), [session.permissions])
  const door = useLogComplaint({ api, companyId, today: romeToday(), can, onLogged })
  const opened = useRef(false)
  const { open } = door
  useEffect(() => {
    if (opened.current) return
    opened.current = true
    open(seed)
  }, [open, seed])
  if (!door.model) return null
  return (
    <ComplaintsMessages>
      <LogComplaintModal model={door.model} prefix={prefix} actions={{ ...door.actions, onLogClose: onClose }} />
    </ComplaintsMessages>
  )
}
