'use client'

import { ExternalLink, FileSignature, FileText, Send } from 'lucide-react'
import { Banner, Card, EmptyState, KeyValue } from '@nexus/ui/components'
import { FileRow } from '../../../../../lib/i18n/ds-parts'
import { PdfViewer } from '@nexus/ui/components/PdfViewer/index'
import { Button, Spinner, Tag } from '@nexus/ui/primitives'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { pdfViewerLabels } from '../../../../../lib/pdf/labels'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { Order } from '../../api'
import { confirmationHeld, confirmationHref, confirmationState, NAMESPACE, packRows } from '../../depth/model'
import type { OrderDepthActions, OrderDepthModel } from '../../depth/use-order-depth'
import '../../depth/depth.css'

/**
 * Documents › Order confirmation (design order.docs.confirmation, SAL-208; on B-W2b-303's API): the newest confirmation in the
 * DS PdfViewer (lines with sizes, prices, dates, terms and each style's certificate class), its version, when it was made and
 * whether it still prints the order as it is, "Sent to, when" (the version sent and the day; the mail itself is on the order's
 * thread), and Make confirmation (the same contents give the newest back), Send… (the one send dialog) and Open in new tab.
 * Refused while the order waits for a yes or was cancelled (said before the click). Fetches nothing.
 */
export function ConfirmationCard({ order, model, actions, prefix }: { order: Order; model: OrderDepthModel | undefined; actions?: OrderDepthActions; prefix: string }) {
  if (!model?.confirmation) return null
  return (
    <WithMessages namespaces={[NAMESPACE, 'shell']}>
      <Confirmation order={order} model={model} actions={actions} prefix={prefix} />
    </WithMessages>
  )
}

function Confirmation({ order, model, actions, prefix }: { order: Order; model: OrderDepthModel; actions?: OrderDepthActions; prefix: string }) {
  const d = useT(NAMESPACE)
  const shell = useT('shell')
  const locale = useLocale()
  const part = model.confirmation!
  const value = part.value
  const head = (
    <div className="fw-sod-head">
      <h2 className="fw-sod-h2">
        <FileSignature size={15} aria-hidden /> {d('confirmation.title')}
      </h2>
      {value && value.versions.length > 0 && (
        <Button size="sm" variant="quiet" asChild>
          <a href={confirmationHref(prefix, order.id)} target="_blank" rel="noopener">
            <ExternalLink size={13} aria-hidden /> {d('confirmation.newTab')}
          </a>
        </Button>
      )}
    </div>
  )
  if (!value) {
    return (
      <Card padded>
        {head}
        {part.problem ? (
          <Banner
            tone="danger"
            title={d('confirmation.failed')}
            action={
              <Button size="sm" onClick={() => actions?.onRetry?.('confirmation')}>
                {d('common.retry')}
              </Button>
            }
          >
            {d(part.problem)}
          </Banner>
        ) : (
          <p className="fw-sod-hint" role="status">
            <Spinner size={14} /> {d('confirmation.reading')}
          </p>
        )}
      </Card>
    )
  }
  const state = confirmationState(value)
  const held = confirmationHeld(value, model.can)
  const newest = value.versions[0] ?? null
  const busy = model.busy ? d('held.busy') : null
  const make = (
    <Button size="sm" variant={state === 'none' ? 'primary' : 'secondary'} heldReason={held ? d(held.key) : busy} onClick={() => actions?.onMakeConfirmation?.()}>
      <FileText size={13} aria-hidden /> {state === 'outdated' ? d('confirmation.makeNew', { version: (newest?.version ?? 0) + 1 }) : d('confirmation.make')}
    </Button>
  )
  const send = model.can.manage ? (
    <Button size="sm" variant={state === 'none' ? 'secondary' : 'primary'} heldReason={held ? d(held.key) : busy} onClick={() => actions?.onDialog?.({ kind: 'send', cc: '', subject: '', message: '' })}>
      <Send size={13} aria-hidden /> {d('confirmation.send')}
    </Button>
  ) : null
  return (
    <Card padded>
      {head}
      {state === 'none' || state === 'notYet' ? (
        <EmptyState
          title={d('confirmation.none')}
          description={state === 'notYet' ? d(held?.key ?? 'confirmation.noneBody') : d('confirmation.noneBody')}
          action={
            model.can.manage ? (
              <span className="fw-sod-actions">
                {make}
                {send}
              </span>
            ) : undefined
          }
        />
      ) : (
        <>
          {state === 'outdated' && <Banner tone="warning" title={d('confirmation.outdated', { version: newest?.version ?? 1 })} />}
          <div className="fw-sod-confirm">
            <div className="fw-sod-confirm-pdf">
              {model.confirmationPdf?.value ? (
                <PdfViewer src={model.confirmationPdf.value} title={d('confirmation.pdfTitle', { number: order.number, version: newest?.version ?? 1 })} fileName={`${order.number}-v${newest?.version ?? 1}.pdf`} labels={pdfViewerLabels(shell)} height="min(70vh, 900px)" />
              ) : model.confirmationPdf?.problem ? (
                <Banner tone="danger" title={d('confirmation.pdfFailed')} />
              ) : !model.can.files ? (
                <p className="fw-sod-hint">{d('confirmation.noFiles')}</p>
              ) : (
                <p className="fw-sod-hint" role="status">
                  <Spinner size={14} /> {d('confirmation.pdfReading')}
                </p>
              )}
            </div>
            <div className="fw-sod-confirm-side">
              <KeyValue
                dense
                labelCase="sentence"
                items={[
                  { label: d('confirmation.version'), value: newest ? (newest.number ?? d('confirmation.versionValue', { version: newest.version })) : '—' },
                  { label: d('confirmation.made'), value: newest ? formatDateTime(newest.createdAt, { locale }) : '—', hint: newest?.createdBy ?? undefined },
                  { label: d('confirmation.state'), value: <Tag tone={state === 'upToDate' ? 'success' : 'warning'}>{d(`confirmation.stateValue.${state}`)}</Tag> },
                  {
                    label: d('confirmation.sent'),
                    value: value.sentAt && value.sentVersion !== null ? d('confirmation.sentValue', { version: value.sentVersion, date: formatDate(value.sentAt, { locale }) }) : d('confirmation.notSent'),
                    hint: value.sentAt ? d('confirmation.sentWhere') : undefined,
                  },
                  { label: d('confirmation.versions'), value: String(value.versions.length) },
                ]}
              />
              {model.can.manage && (
                <span className="fw-sod-actions">
                  {send}
                  {make}
                </span>
              )}
            </div>
          </div>
        </>
      )}
    </Card>
  )
}

/**
 * Documents and files › Brand tech pack in force (design order.docs.files "Brand tech pack in force (W2b)"; B-W2b-295's read
 * through the order's quote and the inquiry it came from): each file of the brand's tech pack, the version named and whether a
 * newer one is in force now (or none is available any more), opened from the file store. Fetches nothing.
 */
export function TechPackCard({ model, actions }: { model: OrderDepthModel | undefined; actions?: OrderDepthActions }) {
  if (!model?.techPack) return null
  return (
    <WithMessages namespaces={[NAMESPACE]}>
      <TechPack model={model} actions={actions} />
    </WithMessages>
  )
}

function TechPack({ model, actions }: { model: OrderDepthModel; actions?: OrderDepthActions }) {
  const d = useT(NAMESPACE)
  const part = model.techPack!
  const rows = packRows(part.value)
  return (
    <Card padded>
      <div className="fw-sod-head">
        <h2 className="fw-sod-h2">{d('pack.title')}</h2>
        {part.value?.inquiry && <span className="fw-sod-hint">{d('pack.from', { number: part.value.inquiry.number })}</span>}
      </div>
      {part.problem ? (
        <Banner
          tone="danger"
          title={d('pack.failed')}
          action={
            <Button size="sm" onClick={() => actions?.onRetry?.('techPack')}>
              {d('common.retry')}
            </Button>
          }
        >
          {d(part.problem)}
        </Banner>
      ) : !part.value ? (
        <p className="fw-sod-hint" role="status">
          <Spinner size={14} /> {d('pack.reading')}
        </p>
      ) : !part.value.inquiry ? (
        <p className="fw-sod-hint">{d('pack.noInquiry')}</p>
      ) : rows.length === 0 ? (
        <p className="fw-sod-hint">{d('pack.none')}</p>
      ) : (
        <>
          {part.value.inquiry.techPack.version && <p className="fw-sod-hint">{d('pack.version', { version: part.value.inquiry.techPack.version })}</p>}
          <div className="fw-sod-files">
            {rows.map((row) => (
              <FileRow
                key={row.id}
                name={row.name}
                size={row.size}
                status={row.state === 'gone' ? d('pack.gone') : row.state === 'newer' ? d('pack.newer', { named: row.named, current: row.current ?? row.named }) : d('pack.inForce', { version: row.named })}
                tone={row.state === 'gone' ? 'danger' : 'neutral'}
                actions={
                  model.can.files && row.available ? (
                    <Button size="sm" variant="quiet" onClick={() => actions?.onOpenFile?.(row.openId)}>
                      {d('pack.open')}
                    </Button>
                  ) : null
                }
              />
            ))}
          </div>
        </>
      )}
    </Card>
  )
}
