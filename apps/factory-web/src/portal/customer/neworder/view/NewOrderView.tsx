'use client'

import type { ReactNode } from 'react'
import { AlertTriangle, ClipboardList, FileSpreadsheet, History, RefreshCw, Shirt, WifiOff } from 'lucide-react'
import { Banner, Card, Field, PressableRow } from '@nexus/ui/components'
import { EndState } from '@nexus/ui/components/EndState/index'
import { SaveStatus, type SaveStatusState } from '@nexus/ui/components/SaveStatus/index'
import { Button, Input, RadioCard, Select } from '@nexus/ui/primitives'
import { DateField, Textarea, useDsWords } from '../../../../lib/i18n/ds-parts'
import type { DraftRecord, DraftRow, RequestStatus } from '../api'
import type { NewOrderPhase } from '../band'
import { draftRowWords, problemPlace, problemWords, requestedHref, shipToOptions, WAYS, newOrderHref, type HeaderDraft, type HeaderField, type Way } from '../model'
import { useOrderingWords } from '../words'
import { DiscardDialog, NewAddressDialog, StylePickerDialog, type AddressDialogActions, type AddressDialogModel, type DiscardModel, type PickerActions, type PickerModel } from './Dialogs'
import { LinesSection, type LinesActions } from './LinesSection'
import { Loading, PricesNote, ReadFailed } from './parts'
import { ReorderPanel, type ReorderActions, type ReorderModel } from './ReorderPanel'
import { UploadPanel, type UploadActions, type UploadModel } from './UploadPanel'

/**
 * SCR-185 › New order & reorder (design portal.customer.neworder): sec:start "How do you want to order?" (three ways in, one
 * draft; the drafts to continue), sec:order-head (their PO, ship-to with "Add a new address", the requested date, a note —
 * saved on leaving a field, SaveStatus), the way's panel (sec:reorder, sec:upload; Pick opens pop:style-picker), sec:lines,
 * sec:summary always in view (a side column on a desktop, the foot on a phone: lines, pieces, net with the price grain, what
 * happens next, Send held with "2 problems — Show me", ⌘Enter), sec:sent (EndState). The pop-ups: Add styles, New delivery
 * address, Discard this draft?
 */

export interface NewOrderViewModel {
  state: 'loading' | 'error' | 'missing' | 'ready'
  phase: NewOrderPhase
  prefix: string
  /** Today in the site's zone: the earliest requested date. */
  today: string
  start: { state: 'loading' | 'error' | 'ready'; drafts: readonly DraftRow[]; choosing: Way | null; held: string | null }
  way: Way | null
  record: DraftRecord | null
  header: HeaderDraft
  /** Field → a key. */
  headerErrors: Partial<Record<HeaderField, string>>
  save: SaveStatusState
  cells: Readonly<Record<string, Readonly<Record<string, number>>>>
  notes: Readonly<Record<string, string>>
  saving: readonly string[]
  /** Why nothing can be written now (words), or null. */
  writeHeld: string | null
  /** "Add a new address": held with the reason (words), or null. */
  addAddressHeld: string | null
  reorder: ReorderModel | null
  upload: UploadModel | null
  /** A refusal in our words (a key), or null. */
  problem: string | null
  /** The draft changed elsewhere while something was typed here. */
  stale: boolean
  notice: { lines: readonly string[]; undo: boolean } | null
  /** Send's held reason (words), or null. */
  sendHeld: string | null
  /** The problems are listed (after Show me, or a send that was held). */
  showProblems: boolean
  sent: { number: string; customerRef: string | null; confirmBy: string | null; lines: number; pieces: number; net: string | null; currency: string; seesPrices: boolean } | null
  closed: { status: RequestStatus; number: string | null; salesOrder: { id: string; number: string } | null } | null
  offlineSince: string | null
  dialogs: { picker: PickerModel | null; address: AddressDialogModel | null; discard: DiscardModel | null }
}

export interface NewOrderActions {
  onWay?: (way: Way) => void
  onContinue?: (draftId: string) => void
  onRetryStart?: () => void
  onHeader?: (field: HeaderField, value: string) => void
  onHeaderLeave?: (field: HeaderField) => void
  onAddAddress?: () => void
  onShowMe?: () => void
  onSend?: () => void
  onTakePrices?: () => void
  onUndo?: () => void
  onDismissNotice?: () => void
  onReload?: () => void
  onRetry?: () => void
  onRetrySave?: () => void
  lines?: LinesActions
  reorder?: ReorderActions
  upload?: UploadActions
  picker?: PickerActions
  address?: AddressDialogActions
  discard?: { onConfirm?: () => void; onCancel?: () => void }
}

const WAY_ICON: Readonly<Record<Way, ReactNode>> = { pick: <Shirt size={18} aria-hidden />, reorder: <History size={18} aria-hidden />, upload: <FileSpreadsheet size={18} aria-hidden /> }

export function NewOrderView({ model, actions }: { model: NewOrderViewModel; actions?: NewOrderActions }) {
  const words = useOrderingWords()
  const { t } = words
  const ds = useDsWords()
  const offline = model.offlineSince ? <Banner tone="warning" icon={<WifiOff size={16} aria-hidden />} title={t('offline.title', { time: words.time(model.offlineSince) })} /> : null

  if (model.phase === 'sent' && model.sent) {
    const sent = model.sent
    const confirmBy = sent.confirmBy ? words.day(sent.confirmBy) : null
    return (
      <div className="fw-pno">
        <EndState
          title={t('sent.title')}
          body={sent.customerRef ? t(confirmBy ? 'sent.bodyRef' : 'sent.bodyRefNoDay', { ref: sent.customerRef, number: sent.number, day: confirmBy ?? '' }) : t(confirmBy ? 'sent.body' : 'sent.bodyNoDay', { number: sent.number, day: confirmBy ?? '' })}
          next={[t('summary.notice'), t('sent.next')]}
          facts={[
            { label: t('summary.lines'), value: String(sent.lines) },
            { label: t('summary.pieces'), value: words.pieces(sent.pieces) },
            ...(sent.seesPrices && sent.net ? [{ label: t('summary.net'), value: words.price(sent.net, sent.currency) ?? '—' }] : []),
          ]}
          reference={{ value: sent.number, label: t('sent.reference') }}
          actions={[
            { label: t('sent.open'), href: requestedHref(model.prefix), variant: 'primary' },
            { label: t('sent.newOrder'), href: newOrderHref(model.prefix) },
          ]}
          labels={ds.endState}
        />
      </div>
    )
  }

  if (model.phase === 'closed' && model.closed) {
    const closed = model.closed
    return (
      <div className="fw-pno">
        <EndState
          tone="info"
          title={closed.number ? t('closed.title', { number: closed.number }) : t('closed.titleNone')}
          body={t(`closed.${closed.status}`, { order: closed.salesOrder?.number ?? '' })}
          actions={[
            { label: t('sent.open'), href: closed.salesOrder ? `${model.prefix}/orders/${encodeURIComponent(closed.salesOrder.id)}` : requestedHref(model.prefix), variant: 'primary' },
            { label: t('sent.newOrder'), href: newOrderHref(model.prefix) },
          ]}
          labels={ds.endState}
          focusOnMount={false}
        />
      </div>
    )
  }

  if (model.state === 'missing') {
    return (
      <div className="fw-pno">
        <EndState
          tone="neutral"
          title={t('missing.title')}
          body={t('missing.body')}
          actions={[{ label: t('sent.newOrder'), href: newOrderHref(model.prefix), variant: 'primary' }]}
          labels={ds.endState}
          focusOnMount={false}
        />
      </div>
    )
  }

  if (model.phase === 'start') {
    return (
      <div className="fw-pno">
        {offline}
        <StartSection model={model} actions={actions} />
      </div>
    )
  }

  if (model.state === 'loading' || (model.state === 'ready' && !model.record)) {
    return (
      <div className="fw-pno">
        <Loading rows={4} height={96} />
      </div>
    )
  }
  if (model.state === 'error' || !model.record) {
    return (
      <div className="fw-pno">
        <ReadFailed title={t('draft.failed')} onRetry={actions?.onRetry} />
      </div>
    )
  }

  const record = model.record
  return (
    <div className="fw-pno">
      {offline}
      {model.stale ? (
        <Banner
          tone="warning"
          title={t('draft.stale')}
          action={
            <Button size="sm" onClick={() => actions?.onReload?.()}>
              <RefreshCw size={14} aria-hidden /> {t('draft.reload')}
            </Button>
          }
        />
      ) : null}
      {model.problem ? <Banner tone="danger" title={t(model.problem)} /> : null}
      {model.notice ? (
        <Banner
          tone="success"
          title={model.notice.lines[0]}
          action={
            <span className="fw-pno-buttons">
              {model.notice.undo ? (
                <Button size="sm" variant="secondary" heldReason={model.writeHeld} onClick={() => actions?.onUndo?.()}>
                  {t('notice.undo')}
                </Button>
              ) : null}
              <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
                {t('notice.hide')}
              </Button>
            </span>
          }
        >
          {model.notice.lines.length > 1 ? (
            <ul className="fw-pno-notes">
              {model.notice.lines.slice(1).map((line, index) => (
                <li key={index}>{line}</li>
              ))}
            </ul>
          ) : null}
        </Banner>
      ) : null}
      <div className="fw-pno-layout">
        <div className="fw-pno-main">
          <StartSection model={model} actions={actions} />
          <OrderHead model={model} actions={actions} />
          {model.way === 'reorder' && model.reorder ? <ReorderPanel model={model.reorder} actions={actions?.reorder} /> : null}
          {model.way === 'upload' && model.upload ? <UploadPanel model={model.upload} actions={actions?.upload} /> : null}
          <LinesSection model={{ record, cells: model.cells, notes: model.notes, saving: model.saving, writeHeld: model.writeHeld }} actions={actions?.lines} />
        </div>
        <aside className="fw-pno-side" aria-labelledby="summary-title">
          <Summary model={model} actions={actions} />
        </aside>
      </div>
      {model.dialogs.picker ? <StylePickerDialog model={model.dialogs.picker} actions={actions?.picker} /> : null}
      {model.dialogs.address ? <NewAddressDialog model={model.dialogs.address} actions={actions?.address} /> : null}
      {model.dialogs.discard ? <DiscardDialog model={model.dialogs.discard} onConfirm={actions?.discard?.onConfirm} onCancel={actions?.discard?.onCancel} /> : null}
    </div>
  )
}

function StartSection({ model, actions }: { model: NewOrderViewModel; actions?: NewOrderActions }) {
  const words = useOrderingWords()
  const { t } = words
  const drafting = model.phase === 'draft'
  return (
    <Card padded>
      <section className="fw-pno-section" aria-labelledby="start-title">
        <h2 id="start-title" className="fw-pno-h2">
          {t('start.title')}
        </h2>
        <fieldset className="fw-pno-ways" disabled={model.start.held !== null && !drafting}>
          <legend className="fw-pno-quiet">{drafting ? t('start.keeps') : t('start.intro')}</legend>
          {WAYS.map((way) => (
            <RadioCard
              key={way}
              name="way"
              value={way}
              checked={model.way === way}
              selected={model.way === way}
              onChange={() => actions?.onWay?.(way)}
              title={
                <span className="fw-pno-waytitle">
                  {WAY_ICON[way]} {t(`start.way.${way}`)}
                </span>
              }
              description={model.start.choosing === way ? t('state.saving') : t(`start.wayHint.${way}`)}
            />
          ))}
        </fieldset>
        {model.start.held && !drafting ? <p className="fw-pno-held">{model.start.held}</p> : null}
        {!drafting ? (
          model.start.state === 'loading' ? (
            <Loading rows={2} height={44} label={t('start.drafts')} />
          ) : model.start.state === 'error' ? (
            <ReadFailed title={t('start.draftsFailed')} onRetry={actions?.onRetryStart} />
          ) : model.start.drafts.length > 0 ? (
            <div className="fw-pno-stack">
              <h3 className="fw-pno-h3">{t('start.drafts')}</h3>
              <ul className="fw-pno-drafts">
                {model.start.drafts.map((row) => (
                  <li key={row.id}>
                    <PressableRow leading={<ClipboardList size={16} aria-hidden />} label={draftRowWords(row, t, words.day)} onClick={() => actions?.onContinue?.(row.id)} />
                  </li>
                ))}
              </ul>
            </div>
          ) : null
        ) : null}
      </section>
    </Card>
  )
}

function OrderHead({ model, actions }: { model: NewOrderViewModel; actions?: NewOrderActions }) {
  const words = useOrderingWords()
  const { t } = words
  const ds = useDsWords()
  const record = model.record!
  const options = shipToOptions(record.addresses, model.header.shipToAddressId || null)
  const chosen = options.find((option) => option.id === model.header.shipToAddressId)
  const error = (field: HeaderField) => (model.headerErrors[field] ? t(model.headerErrors[field]!) : undefined)
  const held = model.writeHeld !== null
  return (
    <Card padded>
      <section className="fw-pno-section" id="order-head" tabIndex={-1} aria-labelledby="head-title">
        <div className="fw-pno-headrow">
          <h2 id="head-title" className="fw-pno-h2">
            {t('head.title')}
          </h2>
          <SaveStatus state={model.save} formatTime={words.time} labels={ds.saveStatus} onRetry={actions?.onRetrySave} retryHeld={model.writeHeld} />
        </div>
        <p className="fw-pno-quiet">{t('head.intro')}</p>
        <div className="fw-pno-fields">
          <Field label={t('head.ref')} hint={t('head.refHint')} error={error('customerRef')}>
            <Input value={model.header.customerRef} maxLength={100} disabled={held} onChange={(event) => actions?.onHeader?.('customerRef', event.target.value)} onBlur={() => actions?.onHeaderLeave?.('customerRef')} />
          </Field>
          <Field label={t('head.date')} hint={t('head.dateHint')} error={error('requestedDate')}>
            <DateField
              value={model.header.requestedDate}
              min={model.today}
              clearable
              disabled={held}
              onChange={(value) => {
                actions?.onHeader?.('requestedDate', value)
                actions?.onHeaderLeave?.('requestedDate')
              }}
            />
          </Field>
          <div className="fw-pno-field-wide">
            <Field
              label={t('head.shipTo')}
              hint={chosen?.state === 'WAITING' ? t('head.shipToWaiting') : chosen?.state === 'ARCHIVED' ? t('head.shipToGone') : options.length === 0 ? t('head.shipToNone') : t('head.shipToHint')}
              error={error('shipToAddressId')}
            >
              <div className="fw-pno-shipto">
                <Select
                  value={model.header.shipToAddressId}
                  disabled={held}
                  onChange={(event) => {
                    actions?.onHeader?.('shipToAddressId', event.target.value)
                    actions?.onHeaderLeave?.('shipToAddressId')
                  }}
                >
                  <option value="">{t('head.shipToChoose')}</option>
                  {options.map((option) => (
                    <option key={option.id} value={option.id}>
                      {[option.name, option.line].filter(Boolean).join(' — ')}
                      {option.isDefault ? ` (${t('head.default')})` : option.state === 'WAITING' ? ` (${t('head.waiting')})` : option.state === 'ARCHIVED' ? ` (${t('head.archived')})` : ''}
                    </option>
                  ))}
                </Select>
                <Button variant="secondary" heldReason={model.addAddressHeld} onClick={() => actions?.onAddAddress?.()}>
                  {t('head.addAddress')}
                </Button>
              </div>
            </Field>
          </div>
          <div className="fw-pno-field-wide fw-pno-notefield">
            <Field label={t('head.note')} hint={t('head.noteHint')} error={error('note')}>
              <Textarea value={model.header.note} rows={2} maxLength={4000} disabled={held} onChange={(event) => actions?.onHeader?.('note', event.target.value)} onBlur={() => actions?.onHeaderLeave?.('note')} />
            </Field>
          </div>
        </div>
      </section>
    </Card>
  )
}

function Summary({ model, actions }: { model: NewOrderViewModel; actions?: NewOrderActions }) {
  const words = useOrderingWords()
  const { t } = words
  const record = model.record!
  const request = record.request
  const kit = { t, price: (value: string | null | undefined) => words.price(value, request.currency) }
  return (
    <Card padded>
      <section
        className="fw-pno-section"
        aria-labelledby="summary-title"
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            if (!model.sendHeld) actions?.onSend?.()
          }
        }}
      >
        <h2 id="summary-title" className="fw-pno-h2">
          {t('summary.title')}
        </h2>
        <dl className="fw-pno-totals">
          <dt>{t('summary.lines')}</dt>
          <dd>{request.summary.lines}</dd>
          <dt>{t('summary.pieces')}</dt>
          <dd>{words.pieces(request.summary.pieces)}</dd>
          {record.seesPrices ? (
            <>
              <dt>{t('summary.net')}</dt>
              <dd>{words.price(request.summary.net, request.currency) ?? '—'}</dd>
            </>
          ) : null}
        </dl>
        {record.seesPrices ? <p className="fw-pno-quiet">{t('summary.netHint')}</p> : <PricesNote />}
        {request.pricesChanged > 0 ? (
          <Banner tone="warning" title={t('summary.pricesChanged', { count: request.pricesChanged })}>
            <Button size="sm" heldReason={model.writeHeld} onClick={() => actions?.onTakePrices?.()}>
              {t('summary.takePrices')}
            </Button>
          </Banner>
        ) : null}
        <p>{t('summary.notice')}</p>
        <div className="fw-pno-sendrow">
          {request.problems.length > 0 ? (
            <p className="fw-pno-held">
              <AlertTriangle size={14} aria-hidden /> {t('summary.problems', { count: request.problems.length })}
              <Button size="sm" variant="quiet" onClick={() => actions?.onShowMe?.()}>
                {t('summary.showMe')}
              </Button>
            </p>
          ) : null}
          {model.showProblems && request.problems.length > 0 ? (
            <ul className="fw-pno-notes">
              {request.problems.map((problem, index) => (
                <li key={index} className="fw-pno-note is-danger">
                  <a href={`#${problemPlace(problem)}`}>{problemWords(problem, request.lines, kit)}</a>
                </li>
              ))}
            </ul>
          ) : null}
          <Button variant="primary" block heldReason={model.sendHeld} onClick={() => actions?.onSend?.()} aria-keyshortcuts="Meta+Enter">
            {t('band.send')}
          </Button>
          <p className="fw-pno-quiet">{t('summary.sendKeys')}</p>
        </div>
      </section>
    </Card>
  )
}
