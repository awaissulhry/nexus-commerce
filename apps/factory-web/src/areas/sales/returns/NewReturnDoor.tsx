'use client'

import { useEffect, useMemo, useRef } from 'react'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { returnsCan, romeToday } from './model'
import { useNewReturn, type NewReturnSeed } from './use-new-return'
import { ReturnsMessages } from './view/parts'
import { NewReturnModal } from './view/NewReturnModal'

/**
 * F-OS-303 (order SHIPMENTS tab; 18-lead-settles L8) — Sales › Returns' OWN New return, opened in place for one customer, order and
 * (from a shipment's row) that shipment's lines: the extracted hook and the same NewReturnModal, mounted only while open. Created, the
 * opener says where it went; Cancel closes it.
 */
export function NewReturnDoor({ seed, companyId, onCreated, onClose }: { seed: NewReturnSeed; companyId: string; onCreated: (created: { readonly id: string; readonly number: string }) => void; onClose: () => void }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const can = useMemo(() => returnsCan(session.permissions), [session.permissions])
  const door = useNewReturn({ api, companyId, today: romeToday(), can: { partiesView: can.partiesView, price: can.price }, onCreated })
  const opened = useRef(false)
  const { open } = door
  useEffect(() => {
    if (opened.current) return
    opened.current = true
    open(seed)
  }, [open, seed])
  if (!door.model) return null
  return (
    <ReturnsMessages>
      <NewReturnModal model={door.model} actions={{ ...door.actions, onNewReturnClose: onClose }} />
    </ReturnsMessages>
  )
}
