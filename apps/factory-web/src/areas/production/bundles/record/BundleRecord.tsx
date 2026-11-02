'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { isApiError } from '../../../../lib/api/errors'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { WithMessages } from '../../../../record-panels/i18n'
import { getTicketPrinters } from '../../_shared/api'
import { useCoalesced, useLive } from '../../_shared/hooks'
import { readProblem, writeProblem } from '../../_shared/model'
import { bundleScans, getBundle, reprintTicket, voidBundle, type RecordScan } from '../api'
import type { Part, ReprintRun } from '../list-model'
import { bundlesCanOf, bundleTabOf, BUNDLES_NAMESPACES, isBundleChange } from '../model'
import type { BundleRecordModel, LoadedBundle } from './record-model'
import { BundleRecordView } from './view/BundleRecordView'

/**
 * `/w/<company>/production/bundles/<id>?tab=progress|scans|quality|ticket` (SCR-259-record): the bundle (production.bundles.view),
 * its scans when the Scans tab is open (workorders.view), Void bundle and Reprint ticket (production.bundles), each with
 * its own Idempotency-Key per dialog. Live: this bundle's work order moving reads it again.
 */
export function BundleRecord({ bundleId }: { bundleId: string }) {
  return (
    <WithMessages namespaces={BUNDLES_NAMESPACES}>
      <Container bundleId={bundleId} />
    </WithMessages>
  )
}

function Container({ bundleId }: { bundleId: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const pathname = usePathname()
  const params = useSearchParams()
  const prefix = pathname.replace(/\/production\/bundles\/[^/]+\/?$/, '')
  const tab = bundleTabOf(params?.get('tab'))
  const can = useMemo(() => bundlesCanOf(session.permissions), [session.permissions])
  const [bundle, setBundle] = useState<LoadedBundle>({ status: 'loading' })
  const [scans, setScans] = useState<Part<RecordScan[]>>({ value: null, problem: null })
  const [notice, setNotice] = useState<BundleRecordModel['notice']>(null)
  const [voiding, setVoiding] = useState<BundleRecordModel['voiding']>(null)
  const [reprint, setReprint] = useState<ReprintRun | null>(null)
  const voidKey = useRef(newIdempotencyKey())
  const reprintKey = useRef(newIdempotencyKey())
  const value = bundle.status === 'ready' ? bundle.value : null
  const workOrderId = value?.workOrder.id ?? null

  const load = useCallback(async () => {
    try {
      setBundle({ status: 'ready', value: await getBundle(api, bundleId) })
    } catch (error) {
      if (isApiError(error) && error.kind === 'not_found') setBundle({ status: 'not_found' })
      else if (isApiError(error) && error.kind === 'forbidden') setBundle({ status: 'forbidden' })
      else setBundle({ status: 'error', problem: readProblem(error) })
    }
  }, [api, bundleId])
  useEffect(() => {
    void load()
  }, [load])

  const readScans = useCallback(() => {
    if (!workOrderId || !can.workOrders) return
    bundleScans(api, workOrderId, bundleId)
      .then((rows) => setScans({ value: rows, problem: null }))
      .catch((error: unknown) => setScans({ value: null, problem: readProblem(error) }))
  }, [api, workOrderId, bundleId, can.workOrders])
  useEffect(() => {
    if (tab === 'scans') readScans()
  }, [tab, readScans])

  const reread = useCoalesced(() => {
    void load()
    if (tab === 'scans') readScans()
  }, 700)
  const live = useLive(
    (change) => {
      if (isBundleChange(change.type) && (change.fields.bundleId === bundleId || change.fields.workOrderId === workOrderId)) reread()
    },
    () => void load(),
  )

  const model: BundleRecordModel = { prefix, can, tab, bundle, scans: can.workOrders ? scans : null, live, notice, voiding, reprint }

  return (
    <BundleRecordView
      model={model}
      actions={{
        onRetry: () => void load(),
        onRetryScans: readScans,
        onDismissNotice: () => setNotice(null),
        onVoidDialog: (open) => {
          voidKey.current = newIdempotencyKey()
          setVoiding(open ? { busy: false, problem: null } : null)
        },
        onVoid: (reason) => {
          if (voiding?.busy) return
          setVoiding({ busy: true, problem: null })
          voidBundle(api, bundleId, reason, voidKey.current)
            .then(() => {
              setVoiding(null)
              setNotice({ tone: 'success', words: { key: 'void.done' } })
              void load()
            })
            .catch((error: unknown) => {
              const words = writeProblem(error, 'bundle')
              setVoiding({ busy: false, problem: { ...words, key: `production:${words.key}` } })
            })
        },
        onReprintDialog: (open) => {
          if (!open || !value) {
            setReprint(null)
            return
          }
          reprintKey.current = newIdempotencyKey()
          setReprint({ rows: [{ id: value.bundle.id, code: value.bundle.code }], printers: { value: null, problem: null }, running: false, done: false, results: {} })
          getTicketPrinters(api, value.workOrder.id)
            .then((printers) => setReprint((current) => (current ? { ...current, printers: { value: printers, problem: null } } : current)))
            .catch((error: unknown) => setReprint((current) => (current ? { ...current, printers: { value: null, problem: readProblem(error) } } : current)))
        },
        onRunReprint: (reason, printerId) => {
          if (!reprint || reprint.running) return
          const run = reprint
          setReprint({ ...run, running: true })
          reprintTicket(api, bundleId, { reason, printerId }, reprintKey.current)
            .then((answer) => {
              setReprint({ ...run, running: false, done: true, results: { [bundleId]: { state: 'done', code: answer.bundle.code, pdf: printerId === null } } })
              void load()
            })
            .catch((error: unknown) => {
              const words = writeProblem(error, 'bundle')
              setReprint({ ...run, running: false, done: true, results: { [bundleId]: { state: 'failed', words: { ...words, key: `production:${words.key}` } } } })
            })
        },
      }}
    />
  )
}
