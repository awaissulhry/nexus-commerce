'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { newIdempotencyKey } from '../../../../../lib/api/client'
import { useOfficeApi, useOfficeSession } from '../../../../../lib/session/context'
import { WithMessages } from '../../../../../record-panels/i18n'
import { readProblem, writeProblem } from '../../../../warehouse/shipments/model'
import { printAndStart, printStartPreview, type PrintPreview } from './api'
import { PRINT_NS, mayPrintOf, startBodyOf, startHeldOf } from './model'
import { PrintSheet } from './sheet/PrintSheet'
import { PrintStartView, type PrintStartViewModel } from './view/PrintStartView'

/**
 * SLOT — owner: S3 (owb-ss4); filled by ss4 step 4.1 (the window "Print and start the work": what prints, the problems in words, Print and start the work).
 * Placed by the base (owb-b5 w5.5) with its FINAL export name and props, so the owner edits only this file. Where: the order page's band
 * opens it as its next act on a confirmed order (S2 of5 mounts it); not mounted by the base. Office only: the customer never reaches it.
 *
 * owb-ss4 (settles L1, L6, L8; server Shape owb-ss2): reads the preview (`GET /production/orders/:orderId/print-start`), then ONE
 * `POST …/print-and-start` (its own Idempotency-Key per version and reason; MATERIAL goes on with the reason) and opens the print sheet of
 * the new print over the page. A refusal reads the preview again: its problems say why in words. Right: production.print.start.
 */
export interface PrintStartWindowProps {
  readonly open: boolean
  readonly onClose: () => void
  /** The company the page works in (the session's). */
  readonly companyId: string
  /** The order (SalesOrder id). */
  readonly orderId: string
}

export function PrintStartWindow(props: PrintStartWindowProps): ReactElement | null {
  if (!props.open) return null
  return (
    <WithMessages namespaces={PRINT_NS}>
      <Container {...props} />
    </WithMessages>
  )
}

function Container({ open, onClose, orderId }: PrintStartWindowProps): ReactElement {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const may = useMemo(() => mayPrintOf(session.permissions), [session.permissions])
  const [preview, setPreview] = useState<PrintPreview | null>(null)
  const [readFailed, setReadFailed] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<PrintStartViewModel['writeProblem']>(null)
  const [printId, setPrintId] = useState<string | null>(null)
  const key = useRef<{ body: string; key: string } | null>(null)

  const load = useCallback(() => {
    printStartPreview(api, orderId)
      .then((value) => {
        setPreview(value)
        setReadFailed(null)
      })
      .catch((error: unknown) => setReadFailed(readProblem(error)))
  }, [api, orderId])
  useEffect(() => load(), [load])

  const held = startHeldOf({ may, preview, reason, busy })

  const start = async () => {
    if (!preview || held) return
    const body = startBodyOf(preview, reason)
    const text = JSON.stringify(body)
    if (key.current?.body !== text) key.current = { body: text, key: newIdempotencyKey() }
    setBusy(true)
    setProblem(null)
    try {
      const started = await printAndStart(api, orderId, body, key.current.key)
      setPrintId(started.printId)
    } catch (error) {
      const said = writeProblem(error)
      setProblem({ key: said.key, detail: said.detail ?? null })
      // A refusal (problems, a version that moved, printed meanwhile): the preview says it again in words.
      load()
    } finally {
      setBusy(false)
    }
  }

  // Started: the print sheet of the new print over the page; closing it closes the window.
  if (printId) return <PrintSheet api={api} orderId={orderId} printId={printId} onClose={onClose} />

  const model: PrintStartViewModel = {
    open,
    state: readFailed ? 'failed' : preview ? 'ready' : 'reading',
    readProblem: readFailed,
    orderNumber: null,
    preview,
    reason,
    held,
    busy,
    writeProblem: problem,
  }
  return (
    <PrintStartView
      model={model}
      actions={{
        onClose: () => {
          if (!busy) onClose()
        },
        onReason: (next) => {
          setReason(next)
          setProblem(null)
        },
        onStart: () => void start(),
      }}
    />
  )
}
