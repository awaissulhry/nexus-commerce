'use client'

import { useEffect, useRef, type ReactNode } from 'react'
import { Check, ChevronLeft, ChevronRight, FileText, MoreHorizontal, ShoppingCart, X, XCircle } from 'lucide-react'
import { Banner, Field, KeyValue, Menu, SummaryTable } from '@nexus/ui/components'
import { Button, Input, Pill, Skeleton, Tag } from '@nexus/ui/primitives'
import { DateField, Modal, Textarea } from '../../../../../../lib/i18n/ds-parts'
import type { CatalogueRecord, IncomingRow } from '../../../api'
import { acceptHeld, catalogueHeld, catalogueMain, catalogueOutcome, lineSizes, refuseHeld, REFUSE_MAX, type CatalogueActions, type CatalogueAction, type CatalogueModel } from '../../../catalogue-model'
// ---- F-CP-157: the accept window's line map ----
import { Plus, Trash2 } from 'lucide-react'
import { Select } from '@nexus/ui/primitives'
import { Combobox } from '../../../../../../lib/i18n/ds-parts'
import { customWords, lineMapRowsOf, linesToMap, MAP_INTO_MAX, ownSizesOf, type CatalogueDialog } from '../../../catalogue-model'
// ---- end F-CP-157
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
          <span className="fw-rp-subject">{model.draft ? model.draft.title /* F-CP-107: a draft has no number yet */ : t('catalogue.title', { number })}</span>
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
          // F-CP-107 (cp-walk): a draft has no number yet — its menu is named by its title, and there is no number to copy.
          triggerProps={{ 'aria-label': t('pane.menu', { number: number || model.draft?.title || request.party.name }) }}
          items={[
            { id: 'customer', label: t('peek.openCustomer'), href: `${model.prefix}/sales/customers/${encodeURIComponent(request.party.id)}`, target: '_blank' as const },
            ...(number ? [{ id: 'copy', label: t('record.copyNumber'), onSelect: () => void navigator.clipboard?.writeText(number).catch(() => undefined) }] : []),
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
        {/* F-CP-107: a draft shows the decisions it will have, each held with why ("The customer is still writing it"). */}
        <div className="fw-rp-actions">{main || (model.draft && request.status === 'DRAFT') ? (['order', 'quote', 'refuse'] as const).map(button) : <span className="fw-inq-hint">{say(outcome)}</span>}</div>
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
                rows={[
                  ...request.lines.map((line) => ({
                    id: line.id,
                    seq: line.seq,
                    cells: [
                      String(line.seq) /* F-CP-157: the request's own place ("Line 2"), as the API names it */,
                      `${line.style.code} · ${line.colourway.code}`,
                      lineSizes(line),
                      <span key="n" className="fw-inq-num">{line.pieces}</span>,
                      ...(model.can.price ? [price(line.unitPriceShown)] : []),
                    ],
                  })),
                  // F-CP-157: the lines in the customer's own words and made to measure, in the request's order (people: how many only).
                  ...(request.customLines ?? []).map((line) => ({
                    id: line.id,
                    seq: line.seq,
                    cells: [
                      String(line.seq),
                      `${t(`catalogueMap.kind.${line.kind}`)} · ${customWords(line, locale)}`,
                      line.sizes.length > 0 ? lineSizes(line) : line.byPerson ? (line.peopleInSheet ? t('catalogueMap.peopleInSheet') : t('catalogueMap.people', { count: line.people.length })) : '—',
                      <span key="n" className="fw-inq-num">{line.pieces}</span>,
                      ...(model.can.price ? ['—'] : []),
                    ],
                  })),
                ]
                  .sort((a, b) => a.seq - b.seq)
                  .map(({ id, cells }) => ({ id, cells }))}
              />
              {request.lines.some((line) => line.problems.length > 0) && (
                <ul className="fw-inq-lines">
                  {request.lines.flatMap((line) => line.problems.map((problem, n) => <li key={`${line.id}-${n}`}>{t('catalogue.lineProblem', { n: line.seq /* F-CP-157 */, words: problem.words[locale] })}</li>))}
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
/** F-CQ-204: exported — the portal order's own windows (Accept as order / quote, Refuse) open on a host's row too, never a copy. */
export function CatalogueDialogs({ model, actions, record }: { model: CatalogueModel; actions?: CatalogueActions; record: CatalogueRecord }) {
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
                String(line.seq) /* F-CP-157 */,
                `${line.style.code} · ${line.colourway.code}`,
                <span key="n" className="fw-inq-num">{line.pieces}</span>,
                ...(model.can.price
                  ? [<Input key="p" size="sm" inputMode="decimal" aria-label={`${t('order.col.price')} · ${t('order.col.n')} ${line.seq}`} placeholder={t('order.pricePlaceholder')} value={dialog.draft.prices[line.id] ?? ''} onChange={(event) => actions?.onPrice?.(line.id, event.target.value)} />]
                  : []),
              ],
            }))}
          />
        )}
        {order && <p className="fw-inq-hint">{model.can.price ? `${t('order.priceHint')} (${record.request.currency})` : t('order.priceHidden')}</p>}
        {/* F-CP-157: the lines in the customer's own words / made to measure, each mapped to the style line(s) it is made into; then
            the line map — what the order or quote gets — before Accept (held in words until every line is mapped). */}
        {linesToMap(record).length > 0 && <LineMap model={model} actions={actions} record={record} dialog={dialog} />}
        {record.request.shipTo?.approvalStatus === 'WAITING' && <p className="fw-inq-hint">{t('catalogue.shipToWaiting')}</p>}
      </div>
    </Modal>
  )
}

// ---- F-CP-157 (customer page plan C5; the API's B-CP-077; lead note 3) --------------------------------------------------------------
/**
 * The accept window's line map: each described / made-to-measure line (its words, colours, pieces, how many people — never their
 * names: they stay on the request) and the style line(s) it is made into — a style of the open range or THIS customer's own label (the
 * picker never offers another customer's), its colourway, its sizes (empty: the line's own, or its people's), for an ORDER with the
 * price grain a unit price; then the map itself, every request line and what it becomes. A made-to-measure request is a quote first.
 */
function LineMap({ model, actions, record, dialog }: { model: CatalogueModel; actions?: CatalogueActions | undefined; record: CatalogueRecord; dialog: Extract<CatalogueDialog, { kind: 'accept' }> }) {
  const { t, locale } = useWords()
  const order = dialog.draft.as === 'ORDER'
  const lines = linesToMap(record)
  const styles = dialog.styles ?? null
  const details = dialog.details ?? {}
  const options = [...(styles?.items ?? []).map((style) => ({ value: style.id, label: `${style.code} · ${style.name}` }))]
  const rows = lineMapRowsOf(record, dialog.draft, locale, (styleId) => details[styleId])
  return (
    <section className="fw-inq-stack" aria-label={t('catalogueMap.title')}>
      <h3 className="fw-inq-h3">{t('catalogueMap.title')}</h3>
      <p className="fw-inq-hint">{t('catalogueMap.hint')}</p>
      {lines.some((line) => line.kind === 'MADE_TO_MEASURE') && <p className="fw-inq-hint">{t('catalogueMap.mtmHint')}</p>}
      {styles === null ? <p className="fw-inq-hint">{t('catalogueMap.noStylesRight')}</p> : styles.problem ? <Banner tone="warning" title={t('line.stylesFailed')}>{t(styles.problem)}</Banner> : null}
      {lines.map((line) => {
        const own = ownSizesOf(line)
        const into = dialog.draft.map?.[line.id] ?? []
        return (
          <div className="fw-inq-line" key={line.id}>
            <div className="fw-inq-line-head">
              <h4 className="fw-inq-h3">{t('catalogueMap.line', { n: line.seq, kind: t(`catalogueMap.kind.${line.kind}`) })}</h4>
              <span className="fw-inq-hint fw-inq-num">{t('catalogueMap.pieces', { count: line.pieces })}</span>
            </div>
            <p className="fw-inq-text">{customWords(line, locale)}</p>
            <p className="fw-inq-hint">
              {[line.byPerson ? (line.peopleInSheet || line.people.length === 0 ? t('catalogueMap.peopleInSheet') : t('catalogueMap.people', { count: line.people.length })) : null, own ? t('catalogueMap.ownSizes', { sizes: own.map((row) => `${row.size}:${row.quantity}`).join(' ') }) : t('catalogueMap.noSizes'), line.note ? t('catalogueMap.note', { note: line.note }) : null].filter(Boolean).join(' · ')}
            </p>
            {into.map((one, place) => {
              const read = one.styleId ? details[one.styleId] : undefined
              const style = read?.status === 'ready' ? read.value : null
              const choices = one.styleId && !options.some((option) => option.value === one.styleId) ? [...options, { value: one.styleId, label: one.styleLabel ?? t('line.thisStyle') }] : options
              const label = t('catalogueMap.into', { m: place + 1, n: line.seq })
              return (
                <div className="fw-inq-line-grid" key={one.key} role="group" aria-label={label}>
                  <Field label={t('line.style')}>
                    {styles && styles.items === null && !styles.problem ? (
                      <Skeleton height={32} />
                    ) : (
                      <Combobox
                        options={choices}
                        value={one.styleId ?? ''}
                        placeholder={styles === null ? t('catalogueMap.noStylesRight') : t('line.style')}
                        onChange={(value) => {
                          const styleId = value || null
                          actions?.onMapInto?.(line.id, one.key, { styleId, styleLabel: styleId ? (choices.find((option) => option.value === value)?.label ?? null) : null })
                          if (styleId) actions?.onMapStyle?.(styleId)
                        }}
                      />
                    )}
                  </Field>
                  <Field label={t('line.colourway')}>
                    {!one.styleId ? (
                      <span className="fw-inq-hint">{t('catalogueMap.colourFirst')}</span>
                    ) : read?.status === 'loading' || !read ? (
                      <Skeleton height={32} />
                    ) : (
                      <Select size="sm" aria-label={`${t('line.colourway')} · ${label}`} value={one.colourwayId ?? ''} onChange={(event) => actions?.onMapInto?.(line.id, one.key, { colourwayId: event.target.value || null })}>
                        <option value="">{t('line.colourway')}</option>
                        {(style?.colourways ?? [])
                          .filter((entry) => entry.status !== 'ARCHIVED' || entry.id === one.colourwayId)
                          .map((entry) => (
                            <option key={entry.id} value={entry.id}>
                              {entry.code} · {entry.name}
                            </option>
                          ))}
                      </Select>
                    )}
                  </Field>
                  <Field label={t('line.sizes')} hint={t('catalogueMap.sizesHint')}>
                    <Input size="sm" aria-label={`${t('line.sizes')} · ${label}`} value={one.sizesText} placeholder="50:5 52:10" onChange={(event) => actions?.onMapInto?.(line.id, one.key, { sizesText: event.target.value })} />
                  </Field>
                  {order && model.can.price && (
                    <Field label={t('order.col.price')}>
                      <Input size="sm" inputMode="decimal" aria-label={`${t('order.col.price')} · ${label}`} placeholder={t('order.pricePlaceholder')} value={one.price} onChange={(event) => actions?.onMapInto?.(line.id, one.key, { price: event.target.value })} />
                    </Field>
                  )}
                  <span className="fw-inq-row">
                    <Button size="sm" variant="quiet" aria-label={t('catalogueMap.remove', { m: place + 1, n: line.seq })} onClick={() => actions?.onMapRemove?.(line.id, one.key)}>
                      <Trash2 size={14} aria-hidden /> {t('line.removeShort')}
                    </Button>
                  </span>
                </div>
              )
            })}
            <span className="fw-inq-row">
              <Button size="sm" variant="secondary" heldReason={into.length >= MAP_INTO_MAX ? t('catalogueMap.addMax', { max: MAP_INTO_MAX }) : null} onClick={() => actions?.onMapAdd?.(line.id)}>
                <Plus size={14} aria-hidden /> {t('catalogueMap.add')}
              </Button>
            </span>
          </div>
        )
      })}
      <h3 className="fw-inq-h3">{order ? t('catalogueMap.mapOrder') : t('catalogueMap.mapQuote')}</h3>
      <SummaryTable
        label={t('catalogueMap.mapLabel')}
        stackOnPhone
        columns={[t('order.col.n'), t('catalogueMap.col.asked'), t('order.col.pieces'), t('catalogueMap.col.becomes')]}
        rows={rows.map((row) => ({
          id: row.id,
          cells: [String(row.n), row.kind === 'CATALOGUE' ? row.asked : `${t(`catalogueMap.kind.${row.kind}`)} · ${row.asked}`, <span key="n" className="fw-inq-num">{row.pieces}</span>, row.becomes.length > 0 ? row.becomes.join(' · ') : t('catalogueMap.notMapped')],
        }))}
      />
    </section>
  )
}
// ---- end F-CP-157
