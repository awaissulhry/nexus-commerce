'use client'

import type { FormEvent } from 'react'
import { Copy, Link2, MapPinned, Send } from 'lucide-react'
import { Banner, Card, Field, SummaryTable } from '@nexus/ui/components'
import { Button, Input, Pill, Skeleton } from '@nexus/ui/primitives'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { LINK_TONE, makeHeldKey, revokeHeldKey, sendHeldKey, type TrackingLinkCardActions, type TrackingLinkCardModel } from '../model'
import '../tracking-link.css'

export type { TrackingLinkCardModel, TrackingLinkCardActions } from '../model'

/**
 * The shipment's branded tracking page, office side (SCR-067 › Tracking & delivery; design warehouse.shipments page.conn
 * "the tracking link (links.tracking)"; B-W2b-170): what the customer follows and who has it — the links made (to whom,
 * how: when the goods left, by the office, copied in the portal, asked again; until when; last opened; withdrawn), the
 * public search's one-day links as one line — and Send the tracking link (to the customer's orders contacts, or to another
 * address), Copy a link to pass on (its address shown this once), Withdraw. Every held button says why.
 */
export function TrackingLinkCardView({ model, actions }: { model: TrackingLinkCardModel; actions?: TrackingLinkCardActions }) {
  return (
    <WithMessages namespaces={['shipment-tracking-link']}>
      <CardBody model={model} actions={actions} />
    </WithMessages>
  )
}

function CardBody({ model, actions }: { model: TrackingLinkCardModel; actions?: TrackingLinkCardActions }) {
  const t = useT('shipment-tracking-link')
  const locale = useLocale()
  const read = model.read
  if (model.state === 'loading' || (model.state === 'ready' && !read)) {
    return (
      <Card header={t('title')} headingLevel={2}>
        <div className="fw-stl" aria-busy="true">
          <Skeleton width="60%" height={16} />
          <Skeleton height={44} />
          <p className="fw-stl-hint" role="status">
            {t('loading')}
          </p>
        </div>
      </Card>
    )
  }
  if (model.state === 'error' || !read) {
    return (
      <Card header={t('title')} headingLevel={2}>
        <Banner tone="danger" title={t('failed')} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('retry')}</Button>} />
      </Card>
    )
  }
  const makeHeld = makeHeldKey(read, model.busy)
  const sendHeld = sendHeldKey(read, model.busy)
  const submitOther = (event: FormEvent) => {
    event.preventDefault()
    if (!makeHeld) actions?.onSendOther?.()
  }
  return (
    <Card
      header={
        <span className="fw-stl-head">
          <MapPinned size={16} aria-hidden /> {t('title')}
        </span>
      }
      headingLevel={2}
      description={t('what')}
      headerAction={
        <Button size="sm" variant={read.links.length === 0 ? 'primary' : 'secondary'} heldReason={sendHeld ? t(sendHeld) : null} onClick={() => actions?.onSend?.()}>
          <Send size={14} aria-hidden /> {read.links.length === 0 ? t('send') : t('sendAgain')}
        </Button>
      }
    >
      <div className="fw-stl">
        {read.recipients.length > 0 ? (
          <p className="fw-stl-hint">{t('to', { names: read.recipients.map((contact) => `${contact.name} (${contact.email})`).join(', ') })}</p>
        ) : (
          <p className="fw-stl-hint">{t('noRecipients')}</p>
        )}
        <div className="fw-stl-actions">
          <Button size="sm" variant="secondary" heldReason={makeHeld ? t(makeHeld) : null} onClick={() => actions?.onCopy?.()}>
            <Link2 size={14} aria-hidden /> {t('copyLink')}
          </Button>
          <Button size="sm" variant="quiet" aria-expanded={model.other.open} onClick={() => actions?.onOther?.(!model.other.open)}>
            {model.other.open ? t('other.close') : t('other.open')}
          </Button>
        </div>
        {model.other.open ? (
          <form className="fw-stl-other" onSubmit={submitOther} noValidate>
            <Field label={t('other.label')} hint={t('other.hint')} error={model.other.problem ? t(`other.problem.${model.other.problem}`) : null}>
              <Input type="email" value={model.other.email} autoComplete="off" onChange={(event) => actions?.onOtherEmail?.(event.target.value)} />
            </Field>
            <div>
              <Button type="submit" size="sm" variant="primary" heldReason={makeHeld ? t(makeHeld) : null}>
                <Send size={14} aria-hidden /> {t('other.send')}
              </Button>
            </div>
          </form>
        ) : null}
        {model.passOn ? (
          <div className="fw-stl-passon" role="status">
            <span className="fw-stl-hint">{model.passOn.copied ? t('passOn.copied') : t('passOn.ready')}</span>
            <code className="fw-stl-url">{model.passOn.url}</code>
            <div>
              <Button size="sm" variant="quiet" onClick={() => actions?.onCopyAgain?.()}>
                <Copy size={13} aria-hidden /> {t('passOn.copy')}
              </Button>
            </div>
            <span className="fw-stl-hint">{t('passOn.once')}</span>
          </div>
        ) : null}
        <div role="status" aria-live="polite">
          {model.outcome?.kind === 'sent' ? <Banner tone="success" title={t('outcome.sent', { count: model.outcome.count })} /> : null}
          {model.outcome?.kind === 'skipped' ? <Banner tone="info" title={t('outcome.skipped')} /> : null}
          {model.outcome?.kind === 'failed' ? <Banner tone="danger" title={t(`outcome.failed.${model.outcome.why}`)} /> : null}
        </div>
        {read.links.length === 0 ? (
          <p className="fw-stl-hint">{read.held ? t(`held.${read.held}`) : t('none')}</p>
        ) : (
          <SummaryTable
            label={t('title')}
            columns={[t('col.to'), t('col.state'), t('col.opened'), t('col.until'), t('col.action')]}
            rows={read.links.map((link) => {
              const held = revokeHeldKey(read, link.state, model.busy)
              return {
                id: link.id,
                cells: [
                  <span key="to" className="fw-stl-cell">
                    <span className="fw-stl-ellipsis">{link.email ?? t('passOnRow')}</span>
                    <span className="fw-stl-sub">{t(`via.${link.via ?? 'OFFICE'}`, { date: formatDate(link.createdAt, { locale }) })}</span>
                  </span>,
                  <Pill key="state" tone={LINK_TONE[link.state]}>
                    {t(`state.${link.state}`)}
                  </Pill>,
                  link.lastOpenedAt ? formatDateTime(link.lastOpenedAt, { locale }) : t('neverOpened'),
                  formatDate(link.endsAt, { locale }),
                  <Button key="revoke" size="sm" variant="quiet" heldReason={held ? t(held) : null} onClick={() => actions?.onRevoke?.(link.id)} aria-label={t('revokeOf', { to: link.email ?? t('passOnRow') })}>
                    {t('revoke')}
                  </Button>,
                ],
              }
            })}
            density="roomy"
            stackOnPhone
          />
        )}
        {read.searches.count > 0 ? <p className="fw-stl-hint">{t('searches', { count: read.searches.count, when: read.searches.lastAt ? formatDateTime(read.searches.lastAt, { locale }) : '—' })}</p> : null}
        <p className="fw-stl-hint">{t('auto')}</p>
      </div>
    </Card>
  )
}
