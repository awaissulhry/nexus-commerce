'use client'

import { FileText, Printer } from 'lucide-react'
import { Banner, EmptyState } from '@nexus/ui/components'
import { PdfViewer } from '@nexus/ui/components/PdfViewer/index'
import { Button, Spinner, Tag } from '@nexus/ui/primitives'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { pdfViewerLabels } from '../../../../../lib/pdf/labels'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { Confirmation } from '../../depth/api'
import { confirmationHeld, confirmationState, NAMESPACE, type DepthCan } from '../../depth/model'
import type { Phrase } from '../../model'
import '../../depth/depth.css'

/** SCR-430 — the confirmation's new tab: the order's confirmation read, the newest PDF, what the person may do. */
export interface ConfirmationPdfModel {
  /** orders.view (and files.read to read the PDF). */
  allowed: boolean
  files: boolean
  can: Pick<DepthCan, 'manage'>
  number: string | null
  confirmation: { status: 'loading' } | { status: 'ready'; value: Confirmation } | { status: 'error'; problem: string }
  /** The newest version's PDF: an address (or bytes in the design cases), null while read. */
  pdf: string | Uint8Array | null
  pdfProblem: string | null
  busy: boolean
  problem: Phrase | null
}

/**
 * tab:orders.confirmation — "Order confirmation PDF" (design sales.orders, "printed and kept beside the phone while confirming
 * with the customer"; B-W2b-303's ORDER_CONFIRMATION document): the newest confirmation in the DS PdfViewer with Print, its
 * version and day, and — when none is made yet or the order changed since — Make confirmation (orders.manage; the same contents
 * give the newest back). Held with its reason while the order waits for a yes or was cancelled. Fetches nothing.
 */
export function ConfirmationPdfView({ model, onMake, onRetry }: { model: ConfirmationPdfModel; onMake?: () => void; onRetry?: () => void }) {
  return (
    <WithMessages namespaces={[NAMESPACE, 'shell']}>
      <Page model={model} onMake={onMake} onRetry={onRetry} />
    </WithMessages>
  )
}

function Page({ model, onMake, onRetry }: { model: ConfirmationPdfModel; onMake?: () => void; onRetry?: () => void }) {
  const d = useT(NAMESPACE)
  const shell = useT('shell')
  const locale = useLocale()
  if (!model.allowed) return <EmptyState title={d('tab.noRight.title')} description={d('tab.noRight.body')} />
  if (model.confirmation.status === 'loading') {
    return (
      <div className="fw-sod-pdf">
        <p className="fw-sod-hint" role="status">
          <Spinner size={14} /> {d('confirmation.reading')}
        </p>
      </div>
    )
  }
  if (model.confirmation.status === 'error') {
    return (
      <div className="fw-sod-pdf">
        <EmptyState
          title={d('confirmation.failed')}
          description={d(model.confirmation.problem)}
          action={
            <Button size="sm" onClick={() => onRetry?.()}>
              {d('common.retry')}
            </Button>
          }
        />
      </div>
    )
  }
  const value = model.confirmation.value
  const state = confirmationState(value)
  const newest = value.versions[0] ?? null
  const held = confirmationHeld(value, model.can)
  const title = newest ? d('confirmation.pdfTitle', { number: value.number, version: newest.version }) : d('tab.title', { number: value.number })
  const make = (
    <Button size="sm" variant={newest ? 'secondary' : 'primary'} heldReason={held ? d(held.key) : model.busy ? d('held.busy') : null} onClick={() => onMake?.()}>
      <FileText size={13} aria-hidden /> {state === 'outdated' ? d('confirmation.makeNew', { version: (newest?.version ?? 0) + 1 }) : d('confirmation.make')}
    </Button>
  )
  return (
    <div className="fw-sod-pdf">
      <div className="fw-sod-head fw-sod-noprint">
        <span className="fw-sod-h2">{title}</span>
        <span className="fw-sod-actions">
          {newest && <Tag tone={state === 'upToDate' ? 'success' : 'warning'}>{d(`confirmation.stateValue.${state}`)}</Tag>}
          {newest && <span className="fw-sod-hint">{d('tab.made', { when: formatDateTime(newest.createdAt, { locale }) })}</span>}
          {model.can.manage && (state === 'none' || state === 'outdated') && make}
          <Button size="sm" variant="primary" heldReason={model.pdf ? null : d('tab.printHeld')} onClick={() => window.print()}>
            <Printer size={13} aria-hidden /> {d('tab.print')}
          </Button>
        </span>
      </div>
      {model.problem && <Banner tone="danger" title={d(model.problem.key, model.problem.params)} />}
      {state === 'outdated' && <Banner tone="warning" title={d('confirmation.outdated', { version: newest?.version ?? 1 })} />}
      {!newest ? (
        <EmptyState title={d('confirmation.none')} description={held ? d(held.key) : d('confirmation.noneBody')} action={model.can.manage ? make : undefined} />
      ) : !model.files ? (
        <p className="fw-sod-hint">{d('confirmation.noFiles')}</p>
      ) : model.pdfProblem ? (
        <Banner
          tone="danger"
          title={d('confirmation.pdfFailed')}
          action={
            <Button size="sm" onClick={() => onRetry?.()}>
              {d('common.retry')}
            </Button>
          }
        />
      ) : model.pdf ? (
        <PdfViewer src={model.pdf} title={title} fileName={`${value.number}-v${newest.version}.pdf`} labels={pdfViewerLabels(shell)} height="min(82vh, 1100px)" />
      ) : (
        <p className="fw-sod-hint" role="status">
          <Spinner size={14} /> {d('confirmation.pdfReading')}
        </p>
      )}
    </div>
  )
}
