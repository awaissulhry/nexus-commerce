'use client'

import { Download, Package, Truck } from 'lucide-react'
import { Banner, Card, KeyValue, SummaryTable } from '@nexus/ui/components'
import { EndState } from '@nexus/ui/components/EndState/index'
import { Button, Pill, Skeleton, Spinner } from '@nexus/ui/primitives'
import { formatDate, formatDateTime } from '../../../lib/i18n/format'
import { useLocale, useT } from '../../../lib/i18n/provider'
import { WithMessages } from '../../../record-panels/i18n'
import { LinkFrameView } from '../../../shell/links/view/LinkFrameView'
import type { ReturnLabelPage } from '../api'
import { bookHeldKey, downloadHeldKey, type ReturnLabelLinkActions, type ReturnLabelLinkModel } from '../model'
import '../return-label-link.css'

export type { ReturnLabelLinkActions, ReturnLabelLinkModel } from '../model'

/**
 * SCR-436 — Your return label (B-W2b-398; LOG-112 "a link that books the carrier only when used"; design sales.returns
 * "Return label or link"): the link frame around ONE task on one phone screen — your return (number, your reference, what
 * to send, by when), the parcel's way (from your town to our return address, the carrier), then Book the carrier (nothing
 * is booked before; once) and Download the label to print and stick on the parcel. A booked label shows its carrier
 * reference; a used one says the goods reached us. A label that cannot be booked now says why and holds the button. No price.
 */
export function ReturnLabelLinkView({ model, actions }: { model: ReturnLabelLinkModel; actions?: ReturnLabelLinkActions }) {
  return (
    <WithMessages namespaces={['shipping-delivery', 'ds-words']}>
      <Page model={model} actions={actions} />
    </WithMessages>
  )
}

function Page({ model, actions }: { model: ReturnLabelLinkModel; actions?: ReturnLabelLinkActions | undefined }) {
  const t = useT('shipping-delivery')
  const page = model.page
  const valid = model.link === 'valid'
  return (
    <LinkFrameView
      model={{
        sender: page ? { name: page.companyName } : null,
        title: page ? t('link.title', { number: page.return.customerRef ?? page.return.number }) : null,
        body: valid ? { kind: 'task' } : { kind: 'link', state: model.link, purpose: 'RETURN_LABEL', expiresAt: null, usesLeft: null },
      }}
    >
      {valid ? (
        page ? (
          <Body page={page} model={model} actions={actions} />
        ) : model.problem ? (
          <Card padded>
            <Banner tone="danger" title={t(model.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('rl.retry')}</Button>} />
          </Card>
        ) : (
          <div className="fw-rll" aria-busy="true">
            <Skeleton height={28} width="60%" />
            <Skeleton height={120} />
            <p className="fw-rll-hint" role="status">
              {t('link.loading')}
            </p>
          </div>
        )
      ) : null}
    </LinkFrameView>
  )
}

function Body({ page, model, actions }: { page: ReturnLabelPage; model: ReturnLabelLinkModel; actions?: ReturnLabelLinkActions | undefined }) {
  const t = useT('shipping-delivery')
  const locale = useLocale()
  const day = (iso: string) => formatDate(`${iso.slice(0, 10)}T12:00:00Z`, { locale, timeZone: 'UTC' })
  const bookHeld = bookHeldKey(model)
  const downloadHeld = downloadHeldKey(model)
  const label = page.label
  const to = page.to
  return (
    <div className="fw-rll">
      {model.offline && <Banner tone="warning" title={t('link.offline')} />}
      {model.problem && <Banner tone="danger" title={t(model.problem)} />}
      {label.status === 'USED' && <EndState tone="success" focusOnMount={false} title={t('link.used.title')} body={t('link.used.body', { at: label.usedAt ? formatDateTime(label.usedAt, { locale }) : '—' })} />}
      <Card padded>
        <div className="fw-rll-stack">
          <h2 className="fw-rll-h2">
            <Package size={16} aria-hidden /> {t('link.what')}
          </h2>
          <KeyValue
            columns={2}
            items={[
              { label: t('link.return'), value: page.return.number },
              ...(page.return.customerRef ? [{ label: t('link.yourRef'), value: page.return.customerRef }] : []),
              ...(page.return.goodsDueBy ? [{ label: t('link.dueBy'), value: day(page.return.goodsDueBy) }] : []),
              { label: t('link.until'), value: formatDate(page.link.expiresAt, { locale }) },
            ]}
          />
          <SummaryTable
            label={t('link.lines')}
            columns={[t('link.col.what'), t('link.col.size'), t('link.col.pieces')]}
            rows={page.lines.map((line) => ({ id: String(line.seq), cells: [line.description, line.size ?? '—', String(line.quantity)] }))}
            align={['left', 'left', 'right']}
            stackOnPhone
          />
        </div>
      </Card>
      <Card padded>
        <div className="fw-rll-stack">
          <h2 className="fw-rll-h2">
            <Truck size={16} aria-hidden /> {t('link.way')}
          </h2>
          <KeyValue
            columns={1}
            items={[
              { label: t('link.from'), value: page.from ? `${page.from.postalCode} ${page.from.city} (${page.from.country})` : '—' },
              { label: t('link.to'), value: to ? [to.companyName ?? to.name, to.line1, to.line2, `${to.postalCode} ${to.city}${to.province ? ` (${to.province})` : ''}`, to.country].filter(Boolean).join(', ') : '—' },
              { label: t('link.carrier'), value: <span className="fw-rll-code">{label.carrierCode}</span> },
              { label: t('link.state'), value: <Pill tone={label.status === 'OFFERED' ? 'info' : 'success'}>{t(`link.status.${label.status}`)}</Pill> },
              ...(label.bookingReference ? [{ label: t('link.reference'), value: <span className="fw-rll-code">{label.bookingReference}</span> }] : []),
            ]}
          />
          <p className="fw-rll-hint">{label.status === 'OFFERED' ? t('link.bookHint') : label.status === 'BOOKED' ? t('link.printHint') : t('link.usedHint')}</p>
          <div className="fw-rll-actions">
            {label.status === 'OFFERED' && (
              <Button variant="primary" heldReason={bookHeld ? t(bookHeld) : null} onClick={() => actions?.onBook?.()}>
                {model.busy === 'book' ? <Spinner size={12} /> : <Truck size={14} aria-hidden />} {t('link.book')}
              </Button>
            )}
            {label.status !== 'OFFERED' && (
              <Button variant={label.status === 'BOOKED' ? 'primary' : 'secondary'} heldReason={downloadHeld ? t(downloadHeld) : null} onClick={() => actions?.onDownload?.()}>
                {model.busy === 'download' ? <Spinner size={12} /> : <Download size={14} aria-hidden />} {t('link.download')}
              </Button>
            )}
          </div>
        </div>
      </Card>
    </div>
  )
}
