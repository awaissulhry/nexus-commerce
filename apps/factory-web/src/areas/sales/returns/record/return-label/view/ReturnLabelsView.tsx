'use client'

import Link from 'next/link'
import { Copy, FileText, Link2, Tag } from 'lucide-react'
import { Banner, Card, EmptyState, Field, SummaryTable } from '@nexus/ui/components'
import { Button, Pill, RadioCard, Select, Skeleton, Spinner } from '@nexus/ui/primitives'
import { formatDate, formatDateTime } from '../../../../../../lib/i18n/format'
import { Modal } from '../../../../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../../record-panels/i18n'
import type { ReturnLabelRow, ReturnLabels } from '../api'
import { cancelHeldKey, confirmHeldKey, labelWindowHref, makeHeldKey, sortedLabels, STATUS_TONE, type MakeDraft, type ReturnLabelsActions, type ReturnLabelsModel } from '../model'
import '../return-label.css'

export type { ReturnLabelsActions, ReturnLabelsModel } from '../model'

/**
 * A return's carrier labels on the RMA's Shipments tab (B-W2b-398; LOG-112; design sales.returns RMA › Shipments,
 * `rma.ship.list` "Return label or link (W2b)" and "Make return label (W2b)"): each label — booked now (its carrier reference
 * and the PDF, opened in the Return label PDF window) or offered by a link (to whom, until when, last opened), used once the
 * goods came back, or withdrawn — and Make return label (a label now from the shipment the goods went out on, the addresses
 * swapped; or a link that books the carrier only when the customer uses it, mailed or passed on). Every held button says why.
 */
export function ReturnLabelsView({ model, actions }: { model: ReturnLabelsModel; actions?: ReturnLabelsActions }) {
  return (
    <WithMessages namespaces={['shipping-delivery']}>
      <Body model={model} actions={actions} />
    </WithMessages>
  )
}

function Body({ model, actions }: { model: ReturnLabelsModel; actions?: ReturnLabelsActions | undefined }) {
  const t = useT('shipping-delivery')
  const read = model.read
  if (model.state === 'loading' || (model.state === 'ready' && !read)) {
    return (
      <Card header={t('rl.title')} headingLevel={2}>
        <div className="fw-rl" aria-busy="true">
          <Skeleton width="50%" height={16} />
          <Skeleton height={40} />
          <p className="fw-rl-hint" role="status">
            {t('rl.loading')}
          </p>
        </div>
      </Card>
    )
  }
  if (model.state === 'error' || !read) {
    return (
      <Card header={t('rl.title')} headingLevel={2}>
        <Banner tone="danger" title={t('rl.failed.read')} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('rl.retry')}</Button>} />
      </Card>
    )
  }
  const held = makeHeldKey(model)
  const rows = sortedLabels(read.labels)
  return (
    <Card
      header={
        <span className="fw-rl-head">
          <Tag size={16} aria-hidden /> {t('rl.title')}
        </span>
      }
      headingLevel={2}
      description={t('rl.what')}
      headerAction={
        <Button size="sm" variant={rows.some((row) => row.status === 'OFFERED' || row.status === 'BOOKED') ? 'secondary' : 'primary'} heldReason={held ? t(held, { days: read.make.linkDays }) : null} onClick={() => actions?.onMake?.()}>
          {t('rl.make')}
        </Button>
      }
    >
      <div className="fw-rl">
        {model.offline && <Banner tone="warning" title={t('rl.offline')} />}
        <Outcome model={model} actions={actions} />
        {model.passOn && (
          <Banner
            tone="info"
            title={t(model.passOn.copied ? 'rl.passOn.copied' : 'rl.passOn.shown')}
            action={
              <Button size="sm" onClick={() => actions?.onCopyAgain?.()}>
                <Copy size={14} aria-hidden /> {t('rl.passOn.copy')}
              </Button>
            }
          >
            <code className="fw-rl-url">{model.passOn.url}</code>
          </Banner>
        )}
        {rows.length === 0 ? (
          <EmptyState title={t('rl.empty.title')} description={t(read.make.held ? `rl.held.code.${read.make.held}` : 'rl.empty.body', { days: read.make.linkDays })} />
        ) : (
          <LabelTable model={model} actions={actions} rows={rows} />
        )}
        {read.make.shipment && !read.make.held && <p className="fw-rl-hint">{t('rl.from', { shipment: read.make.shipment.number })}</p>}
      </div>
      {model.dialog && <MakeDialog read={read} draft={model.dialog} model={model} actions={actions} />}
      {model.cancel && <CancelDialog row={read.labels.find((row) => row.id === model.cancel) ?? null} model={model} actions={actions} />}
    </Card>
  )
}

function Outcome({ model, actions }: { model: ReturnLabelsModel; actions?: ReturnLabelsActions | undefined }) {
  const t = useT('shipping-delivery')
  const outcome = model.outcome
  if (!outcome) return null
  const dismiss = <Button size="sm" variant="ghost" onClick={() => actions?.onDismiss?.()}>{t('rl.dismiss')}</Button>
  if (outcome.kind === 'failed') return <Banner tone="danger" title={t(outcome.key)} action={dismiss} />
  if (outcome.kind === 'booked') return <Banner tone="success" title={t('rl.done.booked')} action={dismiss} />
  if (outcome.kind === 'cancelled') return <Banner tone="success" title={t('rl.done.cancelled')} action={dismiss} />
  return <Banner tone="success" title={t('rl.done.offered', { count: outcome.mailed })} action={dismiss} />
}

function LabelTable({ model, actions, rows }: { model: ReturnLabelsModel; actions?: ReturnLabelsActions | undefined; rows: readonly ReturnLabelRow[] }) {
  const t = useT('shipping-delivery')
  const locale = useLocale()
  const read = model.read!
  return (
    <SummaryTable
      label={t('rl.table')}
      columns={[t('rl.col.what'), t('rl.col.state'), t('rl.col.carrier'), t('rl.col.detail'), t('rl.col.actions')]}
      rows={rows.map((row) => {
        const cancelHeld = cancelHeldKey(model, row)
        return {
          id: row.id,
          cells: [
            <span key="w" className="fw-rl-what">
              {row.mode === 'LINK' ? <Link2 size={14} aria-hidden /> : <FileText size={14} aria-hidden />} {t(`rl.mode.${row.mode}`)}
            </span>,
            <Pill key="s" tone={STATUS_TONE[row.status]}>{t(`rl.status.${row.status}`)}</Pill>,
            <span key="c" className="fw-rl-code">{row.carrierCode}</span>,
            <span key="d" className="fw-rl-detail">{detailOf(t, locale, row)}</span>,
            <span key="a" className="fw-rl-actions">
              {row.file && (
                <Link className="fw-rl-link" href={labelWindowHref(model.prefix, read.return.id, row.id)} target="_blank" rel="noopener">
                  {t('rl.openPdf')}
                </Link>
              )}
              {(row.status === 'OFFERED' || row.status === 'BOOKED') && (
                <Button size="sm" variant="ghost" heldReason={cancelHeld ? t(cancelHeld) : null} onClick={() => actions?.onCancel?.(row.id)}>
                  {t('rl.cancel')}
                </Button>
              )}
            </span>,
          ],
        }
      })}
      stackOnPhone
    />
  )
}

function detailOf(t: ReturnType<typeof useT>, locale: ReturnType<typeof useLocale>, row: ReturnLabelRow): string {
  const parts: string[] = []
  if (row.bookingReference) parts.push(t('rl.reference', { reference: row.bookingReference }))
  if (row.link && row.status === 'OFFERED') {
    parts.push(row.link.email ? t('rl.linkTo', { email: row.link.email }) : t('rl.linkPassedOn'))
    parts.push(t('rl.linkUntil', { day: formatDate(row.link.expiresAt, { locale }) }))
    parts.push(row.link.lastOpenedAt ? t('rl.linkOpened', { at: formatDateTime(row.link.lastOpenedAt, { locale }) }) : t('rl.linkNotOpened'))
  }
  if (row.usedAt) parts.push(t('rl.usedAt', { at: formatDateTime(row.usedAt, { locale }) }))
  if (row.status === 'CANCELLED') parts.push(t('rl.cancelledAt', { at: formatDateTime(row.changedAt, { locale }) }))
  if (parts.length === 0) parts.push(t('rl.madeAt', { at: formatDateTime(row.createdAt, { locale }) }))
  return parts.join(' · ')
}

function MakeDialog({ read, draft, model, actions }: { read: ReturnLabels; draft: MakeDraft; model: ReturnLabelsModel; actions?: ReturnLabelsActions | undefined }) {
  const t = useT('shipping-delivery')
  const held = confirmHeldKey(read, draft, model.busy)
  const set = (over: Partial<MakeDraft>) => actions?.onDraft?.({ ...draft, ...over })
  return (
    <Modal
      open
      onClose={() => actions?.onCloseDialog?.()}
      title={t('rl.dialog.title', { number: read.return.number })}
      size="md"
      footer={
        <>
          <span className="grow" />
          <Button size="sm" onClick={() => actions?.onCloseDialog?.()}>
            {t('rl.dialog.back')}
          </Button>
          <Button size="sm" variant="primary" heldReason={held ? t(held) : null} onClick={() => actions?.onConfirmMake?.()}>
            {model.busy === 'make' ? <Spinner size={12} /> : null} {draft.mode === 'LABEL' ? t('rl.dialog.book') : draft.send ? t('rl.dialog.mail') : t('rl.dialog.passOn')}
          </Button>
        </>
      }
    >
      <div className="fw-rl-dialog">
        {model.outcome?.kind === 'failed' && <Banner tone="danger" title={t(model.outcome.key)} />}
        <fieldset className="fw-rl-choices">
          <legend className="fw-rl-legend">{t('rl.dialog.how')}</legend>
          <RadioCard name="rl-mode" value="LABEL" checked={draft.mode === 'LABEL'} selected={draft.mode === 'LABEL'} onChange={() => set({ mode: 'LABEL' })} title={t('rl.dialog.label')} description={t('rl.dialog.labelLine')} />
          <RadioCard name="rl-mode" value="LINK" checked={draft.mode === 'LINK'} selected={draft.mode === 'LINK'} onChange={() => set({ mode: 'LINK' })} title={t('rl.dialog.link')} description={t('rl.dialog.linkLine', { days: read.make.linkDays })} />
        </fieldset>
        {read.make.shipments.length > 1 && (
          <Field label={t('rl.dialog.shipment')} hint={t('rl.dialog.shipmentHint')}>
            <Select value={draft.shipmentId ?? ''} onChange={(event) => set({ shipmentId: event.target.value })}>
              {read.make.shipments.map((shipment) => (
                <option key={shipment.id} value={shipment.id}>
                  {shipment.number}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {draft.mode === 'LINK' && (
          <fieldset className="fw-rl-choices">
            <legend className="fw-rl-legend">{t('rl.dialog.send')}</legend>
            <RadioCard name="rl-send" value="mail" checked={draft.send} selected={draft.send} onChange={() => set({ send: true })} title={t('rl.dialog.sendMail')} description={read.recipients.length > 0 ? t('rl.dialog.sendTo', { names: read.recipients.map((contact) => `${contact.name} (${contact.email})`).join(', ') }) : t('rl.held.code.NO_RECIPIENT')} />
            <RadioCard name="rl-send" value="pass" checked={!draft.send} selected={!draft.send} onChange={() => set({ send: false })} title={t('rl.dialog.sendPass')} description={t('rl.dialog.sendPassLine')} />
          </fieldset>
        )}
        <p className="fw-rl-hint">{draft.mode === 'LABEL' ? t('rl.dialog.labelNote') : t('rl.dialog.linkNote')}</p>
      </div>
    </Modal>
  )
}

function CancelDialog({ row, model, actions }: { row: ReturnLabelRow | null; model: ReturnLabelsModel; actions?: ReturnLabelsActions | undefined }) {
  const t = useT('shipping-delivery')
  if (!row) return null
  const held = cancelHeldKey(model, row)
  return (
    <Modal
      open
      onClose={() => actions?.onCancel?.(null)}
      title={t('rl.cancelDialog.title')}
      size="sm"
      footer={
        <>
          <span className="grow" />
          <Button size="sm" onClick={() => actions?.onCancel?.(null)}>
            {t('rl.dialog.back')}
          </Button>
          <Button size="sm" variant="danger" heldReason={held ? t(held) : null} onClick={() => actions?.onConfirmCancel?.()}>
            {model.busy === `cancel:${row.id}` ? <Spinner size={12} /> : null} {t('rl.cancelDialog.confirm')}
          </Button>
        </>
      }
    >
      <p>{t(row.status === 'OFFERED' ? 'rl.cancelDialog.offered' : 'rl.cancelDialog.booked', { reference: row.bookingReference ?? '' })}</p>
    </Modal>
  )
}
