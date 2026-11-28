'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Banner } from '@nexus/ui/components'
import { Button, Skeleton } from '@nexus/ui/primitives'
import { isApiError } from '../../../../lib/api/errors'
import { Modal } from '../../../../lib/i18n/ds-parts'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { WithMessages } from '../../../../record-panels/i18n'
import { todayIn } from '../../../../lib/order-draft/model'
import type { DraftRecord } from '../../../../lib/order-draft/schema'
import { DRAFT_NS, DraftDoorProvider, useDraftWords } from '../../../../lib/order-draft/words'
import { findStyles } from '../../inquiries/api'
import { mapStylesOf } from '../../inquiries/catalogue-model'
import { useFlowWords } from '../record/flow-words'
import { confirmDraft, officeDraftPort, readOfficeRequest, type ConfirmAnswer } from './api'
import { useConfirmOrder } from './use-confirm-order'
import { ConfirmOrderWindowView } from './view/ConfirmOrderWindowView'

export interface ConfirmOrderWindowProps {
  readonly open: boolean
  readonly onClose: () => void
  /** The Draft or Sent order (the PortalOrderRequest id). */
  readonly requestId: string
  /** After the confirm: what it made (the order, or a quote for a custom size); the window has closed. */
  readonly onConfirmed?: (made: ConfirmAnswer['made']) => void
}

/**
 * owb-of5 step 4 — THE Confirm window for a page that does not hold the draft (the orders sheet, Incoming, the band of another page):
 * it reads the draft and the customer's styles itself, then draws the same window the draft page draws (ConfirmOrderWindowView through
 * useConfirmOrder): the promised day, the open details as yellow lines, a line without a product held (A-5). One command, today's
 * `POST /sales/order-requests/:id/confirm` (orders.manage). Office only.
 */
export function ConfirmOrderWindow(props: ConfirmOrderWindowProps) {
  if (!props.open) return null
  return (
    <WithMessages namespaces={[DRAFT_NS, 'ds-words']}>
      <DraftDoorProvider door="office">
        <ConfirmOrderContainer {...props} />
      </DraftDoorProvider>
    </WithMessages>
  )
}

function ConfirmOrderContainer({ onClose, requestId, onConfirmed }: ConfirmOrderWindowProps) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const { t, locale } = useDraftWords()
  const f = useFlowWords()
  const today = useMemo(() => todayIn(), [])
  const port = useMemo(() => officeDraftPort(api), [api])
  const [record, setRecord] = useState<DraftRecord | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [styles, setStyles] = useState<{ id: string; code: string; name: string }[] | null>(null)
  const recordRef = useRef<DraftRecord | null>(null)
  recordRef.current = record

  useEffect(() => {
    const abort = new AbortController()
    setRecord(null)
    setProblem(null)
    port
      .read(requestId, abort.signal)
      .then(setRecord)
      .catch((error: unknown) => setProblem(isApiError(error) && error.message ? error.message : 'cf.readFailed'))
    readOfficeRequest(api, requestId, abort.signal)
      .then((office) => findStyles(api, '', abort.signal).then((all) => setStyles(mapStylesOf(all, office.request.party.id).map((style) => ({ id: style.id, code: style.code, name: style.name })))))
      .catch(() => setStyles([]))
    return () => abort.abort()
  }, [api, port, requestId])

  const confirm = useConfirmOrder({
    api,
    record,
    locale,
    today,
    send: (body) => confirmDraft(api, requestId, { version: recordRef.current?.request.version ?? 0, ...body }),
    onDone: (made) => {
      onConfirmed?.(made)
      onClose()
    },
  })
  // The window opens on the draft as soon as it is read.
  const opened = useRef(false)
  useEffect(() => {
    if (record && !opened.current) {
      opened.current = true
      confirm.actions.onOpen?.()
    }
  }, [record, confirm.actions])

  const leave = () => {
    if (confirm.state?.busy) return
    confirm.actions.onClose?.()
    onClose()
  }
  if (!record || !confirm.state) {
    return (
      <Modal
        open
        size="md"
        onClose={onClose}
        title={f('cf.windowTitle')}
        footer={
          <Button variant="secondary" onClick={onClose}>
            {t('pc.cancel')}
          </Button>
        }
      >
        {problem ? <Banner tone="danger" title={problem === 'cf.readFailed' ? f('cf.readFailed') : problem} /> : <Skeleton height={96} />}
      </Modal>
    )
  }
  return (
    <ConfirmOrderWindowView
      model={{ record, confirm: confirm.state, details: confirm.details, styles, writeHeld: session.permissions.includes('orders.manage') ? null : t('save.readonly'), today }}
      actions={{ ...confirm.actions, onClose: leave }}
    />
  )
}
