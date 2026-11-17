'use client'

import { useEffect, useRef, type ReactNode } from 'react'
import { Check, ChevronLeft, ChevronRight, FileText, MoreHorizontal, ShoppingCart, X, XCircle } from 'lucide-react'
import { Banner, Field, KeyValue, Menu, SummaryTable } from '@nexus/ui/components'
import { Button, Input, Pill, Skeleton, Tag } from '@nexus/ui/primitives'
import { DateField, Modal, Textarea } from '../../../../../../lib/i18n/ds-parts'
import type { CatalogueRecord, IncomingRow } from '../../../api'
import { acceptHeld, catalogueHeld, catalogueMain, catalogueOutcome, lineSizes, refuseHeld, REFUSE_MAX, type CatalogueActions, type CatalogueAction, type CatalogueModel } from '../../../catalogue-model'
import { priceText, waitingOf, type Phrase } from '../../../model'
import { isPageKey, NoticeLine, useWords } from '../../../parts'
import type { PaneNav } from '../RequestPane'

/**
 * B-TH-233 (threads plan TH-3; B-TH-040, O-SAL-INQ-LIST.pane-actions-F13): a catalogue order beside the Incoming list, read like the
 * request's pane — row 1 its identity (the kind mark · customer — "Catalogue order <number>" · its state with the waiting · "3 of
 * 41" · ⋯ · ×), row 2 ONE main button (Accept as order while it may) with Accept as quote and Refuse beside it, each held with its
 * reason (the production manager: "Only sales can accept or refuse a catalogue order"), the outcome once decided, then the thread
 * (shared with this customer only) and its Details (their PO, the date asked, the ship-to — a new one the customer added waits for
 * the check, accepting approves it —, the lines with sizes and pieces, prices only with the price grain). Draws its model.
 */

const INTL = { it: 'it-IT', en: 'en-GB' } as const
const STATE_TONE = { DRAFT: 'neutral', SENT: 'info', ACCEPTED: 'success', REFUSED: 'neutral', WITHDRAWN: 'neutral' } as const

export interface CataloguePaneProps {
  readonly model: CatalogueModel
  readonly actions?: CatalogueActions
  /** The catalogue order's thread (the container's OfficeRecordThread). */
  readonly thread?: ReactNode
  /** Its Incoming row (the waiting time on our calendar, the company), when the list holds it. */
  readonly row?: IncomingRow | null
  readonly nav?: PaneNav | null
  readonly onClose?: () => void
  readonly onNext?: () => void
  /** The company's name when the reader sees more than one. */
  readonly companyName?: string | null
}

export function CataloguePane(props: CataloguePaneProps) {
  const { model, actions, onClose } = props
  const { t } = useWords()
  if (model.loaded.status === 'loading')
    return (
      <div className="fw-rp" aria-busy="true">
        <p className="fw-inq-hint" role="status">
          {t('catalogue.reading')}
        </p>
        <Skeleton height={40} />
        <Skeleton height={32} width="70%" />
        <Skeleton height={320} />
      </div>
    )
  if (model.loaded.status !== 'ready') {
    // Another customer's catalogue order, or one this reader may not open, reads "not found" — never that it exists.
    const status = model.loaded.status
    return (
      <div className="fw-rp">
        <Banner
          tone={status === 'error' ? 'danger' : 'info'}
          title={status === 'error' ? t('catalogue.failed') : status === 'forbidden' ? t('catalogue.noRight') : t('catalogue.notFound')}
          action={
            <span className="fw-inq-actions">
              {status === 'error' && (
                <Button size="sm" onClick={() => actions?.onRetry?.()}>
                  {t('common.retry')}
                </Button>
              )}
              {onClose && (
                <Button size="sm" variant="quiet" onClick={onClose}>
                  {t('pane.close')}
                </Button>
              )}
            </span>
          }
        >
          {status === 'error' ? t(model.loaded.problem) : status === 'forbidden' ? t('catalogue.noRightBody') : t('catalogue.notFoundBody')}
        </Banner>
      </div>
    )
  }
  return <Loaded {...props} record={model.loaded.value} />
}

function Loaded({ model, actions, thread, row, nav, onClose, onNext, companyName, record }: CataloguePaneProps & { record: CatalogueRecord }) {
  const { t, say, day, when, locale } = useWords()
  const request = record.request
  const number = request.number ?? ''
  const index = nav ? nav.ids.indexOf(request.id) : -1
  const latest = useRef({ nav, onClose })
  latest.current = { nav, onClose }

  // J / K the next and previous row that opens here, Esc closes — as in the request's pane (never from the thread's feed or a field).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.key !== 'j' && event.key !== 'k' && event.key !== 'Escape') || !isPageKey(event)) return
      if ((event.target as HTMLElement | null)?.closest('.fw-rt-column')) return
      const { nav: now, onClose: close } = latest.current
      if (event.key === 'Escape') {
        if (!close) return
        event.preventDefault()
        close()
        return
      }
      if (!now) return
      const at = now.ids.indexOf(request.id)
      const next = event.key === 'j' ? now.ids[at + 1] : now.ids[at - 1]
      if (at < 0 || !next) return
      event.preventDefault()
      event.stopPropagation()
      now.onGo(next)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [request.id])

  const main = catalogueMain(record, model.can)
  const held = (action: CatalogueAction) => say(catalogueHeld(record, action, model.can, model.offline))
  const waiting = row ? waitingOf(row) : null
  const outcome = catalogueOutcome(record)
  const button = (action: CatalogueAction): ReactNode => {
    const label = action === 'order' ? t('catalogue.acceptOrder') : action === 'quote' ? t('catalogue.acceptQuote') : t('catalogue.refuse')
    const run = () => (action === 'refuse' ? actions?.onRefuse?.() : actions?.onAccept?.(action === 'order' ? 'ORDER' : 'QUOTE'))
    return (
      <Button key={action} size="sm" variant={action === main ? 'primary' : action === 'refuse' ? 'danger-outline' : 'secondary'} heldReason={held(action)} onClick={run}>
        {action === 'order' ? <Check size={14} aria-hidden /> : action === 'quote' ? <FileText size={14} aria-hidden /> : <XCircle size={14} aria-hidden />} {label}
      </Button>
    )
  }
  const price = (value: string | null | undefined) => (value ? priceText(value, request.currency, INTL[locale]) : '—')
  const ship = request.shipTo
  const facts: { label: string; value: ReactNode }[] = [
    { label: t('pane.facts.number'), value: companyName ? `${number} · ${companyName}` : number },
    { label: t('catalogue.facts.sent'), value: request.sentBy ? t('catalogue.facts.sentBy', { when: when(request.sentAt), name: request.sentBy }) : when(request.sentAt) },
    { label: t('pane.facts.po'), value: request.customerRef ?? '—' },
    { label: t('catalogue.facts.asked'), value: day(request.requestedDate) },
    {
      label: t('pane.facts.shipTo'),
      value: ship ? (
        <span className="fw-inq-row">
          <span>{[ship.name, ship.line1, `${ship.postalCode} ${ship.city}`, ship.country].filter(Boolean).join(', ')}</span>
          {ship.approvalStatus === 'WAITING' && <Tag tone="warning" title={t('catalogue.facts.shipToWaitingHint')}>{t('pane.facts.shipToWaiting')}</Tag>}
        </span>
      ) : (
        '—'
      ),
    },
    { label: t('pane.facts.quantity'), value: t('catalogue.facts.pieces', { count: request.summary.lines, lines: request.summary.lines, pieces: request.summary.pieces }) },
    ...(model.can.price ? [{ label: t('catalogue.facts.net'), value: price(request.summary.netShown) }] : []),
  ]
  return (
    <div className="fw-rp is-pane" data-place="pane">
      <header className="fw-rp-head">
        <span className="fw-rp-pic" aria-hidden>
          <ShoppingCart size={16} />
        </span>
        <h2 className="fw-rp-title" title={`${number} · ${request.party.name}`}>
          <span className="fw-rp-who">{request.party.name}</span>
          <span className="fw-rp-sep" aria-hidden>
            —
          </span>
          <span className="fw-rp-subject">{t('catalogue.title', { number })}</span>
        </h2>
        <span className="fw-rp-state">
          <Pill tone={STATE_TONE[request.status]}>{request.words[locale]}</Pill>
          {waiting?.time && <span className={waiting.tone === 'warning' ? 'fw-rp-wait is-late' : 'fw-rp-wait'}>{say(waiting.time)}</span>}
        </span>
        {nav && index >= 0 && nav.ids.length > 1 && (
          <span className="fw-rp-nav">
            <Button size="sm" variant="quiet" aria-label={t('pane.prev')} aria-keyshortcuts="k" heldReason={index === 0 ? t('pane.atFirst') : null} onClick={() => nav.ids[index - 1] && nav.onGo(nav.ids[index - 1]!)}>
              <ChevronLeft size={14} aria-hidden />
            </Button>
            <span className="fw-rp-of">{t('pane.of', { n: index + 1, total: nav.ids.length })}</span>
            <Button size="sm" variant="quiet" aria-label={t('pane.next')} aria-keyshortcuts="j" heldReason={index === nav.ids.length - 1 ? t('pane.nothingElse') : null} onClick={() => nav.ids[index + 1] && nav.onGo(nav.ids[index + 1]!)}>
              <ChevronRight size={14} aria-hidden />
            </Button>
          </span>
        )}
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('pane.menu', { number }) }}
          items={[
            { id: 'customer', label: t('peek.openCustomer'), href: `${model.prefix}/sales/customers/${encodeURIComponent(request.party.id)}`, target: '_blank' as const },
            { id: 'copy', label: t('record.copyNumber'), onSelect: () => void navigator.clipboard?.writeText(number).catch(() => undefined) },
          ]}
        />
        {onClose && (
          <Button size="sm" variant="quiet" aria-label={t('pane.close')} aria-keyshortcuts="Escape" onClick={onClose}>
            <X size={16} aria-hidden />
          </Button>
        )}
      </header>
      {model.handled && (
        <Banner
          tone="warning"
          title={t('catalogue.handled', { time: model.handled })}
          action={
            <span className="fw-inq-actions">
              <Button size="sm" variant="quiet" onClick={() => actions?.onReload?.()}>
                {t('record.reload')}
              </Button>
              {onNext && (
                <Button size="sm" variant="quiet" onClick={onNext}>
                  {t('pane.next')}
                </Button>
              )}
            </span>
          }
        />
      )}
      {model.offline && <Banner tone="warning" title={t('record.offline')} />}
      <NoticeLine notice={model.notice} onDismiss={actions?.onDismissNotice} />
      <div className="fw-rp-row2">
        <div className="fw-rp-actions">{main ? (['order', 'quote', 'refuse'] as const).map(button) : <span className="fw-inq-hint">{say(outcome)}</span>}</div>
      </div>
      {main && ship?.approvalStatus === 'WAITING' && <p className="fw-inq-hint">{t('catalogue.shipToWaiting')}</p>}
      <div className="fw-rp-body">
        <div className="fw-rp-main">
          <div className="fw-rp-thread">{thread ?? <p className="fw-inq-hint">{model.can.thread ? t('activity.none') : t('activity.noRight')}</p>}</div>
        </div>
        <aside className="fw-rp-details" aria-label={t('pane.details')}>
          <div className="fw-rp-facts">
            <section className="fw-rp-sec">
              <h3 className="fw-rp-h3">{t('pane.details')}</h3>
              <KeyValue items={facts} labelCase="sentence" />
            </section>
            <section className="fw-rp-sec">
              <h3 className="fw-rp-h3">{t('pane.facts.lines')}</h3>
              <SummaryTable
                label={t('pane.facts.lines')}
                columns={[t('order.col.n'), t('order.col.style'), t('catalogue.col.sizes'), t('order.col.pieces'), ...(model.can.price ? [t('catalogue.col.shown')] : [])]}
                rows={request.lines.map((line) => ({
                  id: line.id,
                  cells: [
                    String(line.seq / 10),
                    `${line.style.code} · ${line.colourway.code}`,
                    lineSizes(line),
                    <span key="n" className="fw-inq-num">{line.pieces}</span>,
                    ...(model.can.price ? [price(line.unitPriceShown)] : []),
                  ],
                }))}
              />
              {request.lines.some((line) => line.problems.length > 0) && (
                <ul className="fw-inq-lines">
                  {request.lines.flatMap((line) => line.problems.map((problem, n) => <li key={`${line.id}-${n}`}>{t('catalogue.lineProblem', { n: line.seq / 10, words: problem.words[locale] })}</li>))}
                </ul>
              )}
            </section>
            {request.note && (
              <section className="fw-rp-sec">
                <h3 className="fw-rp-h3">{t('catalogue.facts.note')}</h3>
                <p className="fw-inq-text">{request.note}</p>
              </section>
            )}
          </div>
        </aside>
      </div>
      <CatalogueDialogs model={model} actions={actions} record={record} />
    </div>
  )
}

/** Accept as order (the promise date, a price per line with the price grain), Accept as quote, Refuse (the words the customer reads). */
function CatalogueDialogs({ model, actions, record }: { model: CatalogueModel; actions?: CatalogueActions; record: CatalogueRecord }) {
  const { t, say } = useWords()
  const dialog = model.dialog
  if (!dialog) return null
  const number = record.request.number ?? ''
  const close = () => actions?.onCloseDialog?.()
  if (dialog.kind === 'refuse') {
    const heldPhrase: Phrase | null = dialog.busy ? { key: 'common.working' } : refuseHeld(dialog.reason, model.offline)
    return (
      <Modal
        open
        onClose={close}
        size="md"
        title={t('catalogue.refuseTitle', { number })}
        subtitle={record.request.party.name}
        footer={
          <span className="fw-inq-buttons">
            <Button variant="secondary" onClick={close}>
              {t('common.cancel')}
            </Button>
            <Button variant="danger" heldReason={say(heldPhrase)} onClick={() => actions?.onSubmit?.()}>
              <XCircle size={14} aria-hidden /> {t('catalogue.refuse')}
            </Button>
          </span>
        }
      >
        <div className="fw-inq-dialog">
          <NoticeLine notice={dialog.notice} />
          <Field label={t('catalogue.refuseReason')} hint={t('catalogue.refuseHint')}>
            <Textarea value={dialog.reason} rows={4} honourRows maxLength={REFUSE_MAX} onChange={(event) => actions?.onReason?.(event.target.value)} />
          </Field>
          {dialog.reason.trim() && (
            <Banner tone="info" title={t('catalogue.refusePreview', { customer: record.request.party.name })}>
              <p className="fw-inq-text">{dialog.reason.trim()}</p>
            </Banner>
          )}
        </div>
      </Modal>
    )
  }
  const order = dialog.draft.as === 'ORDER'
  const heldPhrase: Phrase | null = dialog.busy ? { key: 'common.working' } : acceptHeld(record, dialog.draft, model.can, model.offline)
  return (
    <Modal
      open
      onClose={close}
      size="lg"
      title={order ? t('catalogue.acceptOrderTitle', { number }) : t('catalogue.acceptQuoteTitle', { number })}
      subtitle={record.request.party.name}
      footer={
        <span className="fw-inq-buttons">
          <Button variant="secondary" onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" heldReason={say(heldPhrase)} onClick={() => actions?.onSubmit?.()}>
            {order ? t('catalogue.acceptOrder') : t('catalogue.acceptQuote')}
          </Button>
        </span>
      }
    >
      <div className="fw-inq-dialog">
        <NoticeLine notice={dialog.notice} />
        <p className="fw-inq-hint">{order ? t('catalogue.acceptOrderHint') : t('catalogue.acceptQuoteHint')}</p>
        {order && (
          <Field label={t('catalogue.promise')} hint={t('catalogue.promiseHint')}>
            <DateField value={dialog.draft.promiseDate ?? ''} clearable onChange={(value) => actions?.onDraft?.({ promiseDate: value || null })} />
          </Field>
        )}
        {order && (
          <SummaryTable
            label={t('pane.facts.lines')}
            columns={[t('order.col.n'), t('order.col.style'), t('order.col.pieces'), ...(model.can.price ? [t('order.col.price')] : [])]}
            rows={record.request.lines.map((line) => ({
              id: line.id,
              cells: [
                String(line.seq / 10),
                `${line.style.code} · ${line.colourway.code}`,
                <span key="n" className="fw-inq-num">{line.pieces}</span>,
                ...(model.can.price
                  ? [<Input key="p" size="sm" inputMode="decimal" aria-label={`${t('order.col.price')} · ${t('order.col.n')} ${line.seq / 10}`} placeholder={t('order.pricePlaceholder')} value={dialog.draft.prices[line.id] ?? ''} onChange={(event) => actions?.onPrice?.(line.id, event.target.value)} />]
                  : []),
              ],
            }))}
          />
        )}
        {order && <p className="fw-inq-hint">{model.can.price ? `${t('order.priceHint')} (${record.request.currency})` : t('order.priceHidden')}</p>}
        {record.request.shipTo?.approvalStatus === 'WAITING' && <p className="fw-inq-hint">{t('catalogue.shipToWaiting')}</p>}
      </div>
    </Modal>
  )
}
