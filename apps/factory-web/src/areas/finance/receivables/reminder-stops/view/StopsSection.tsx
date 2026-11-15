'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { Download, MoreHorizontal } from 'lucide-react'
import { Banner, EmptyState, Field, Menu } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Pill, Select } from '@nexus/ui/primitives'
import { DateField, Textarea } from '../../../../../lib/i18n/ds-parts'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { INTL_LOCALE } from '../../../../../lib/i18n/locales'
import { useLocale, useScopedT, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { dayInstant } from '../../../_shared/model'
import { DialogFrame } from '../../../_shared/parts'
import { PAY_DEPTH, PAY_DEPTH_NAMESPACES, type PayProblem, type Phrase } from '../../../payments/riba/depth'
import { MAX_STOP_TEXT, STOP_STATES, type ReminderStop, type StopState } from '../api'
import { STOP_TONE, stopMoveHeld, type StopsCan } from '../model'
import '../../../_shared/finance.css'

export type StopDialog = { kind: 'lift'; stop: ReminderStop } | { kind: 'change'; stop: ReminderStop }

export interface StopsSectionModel {
  prefix: string
  today: string
  can: StopsCan
  state: StopState
  stops: ReminderStop[] | null
  problem: string | null
  updates: number
  dialog: StopDialog | null
  busy: boolean
  writeProblem: PayProblem | null
  notice: Phrase | null
  /** Design cases: the starting selection; what a dialog holds typed. */
  selected?: string[]
  draft?: { reason?: string; until?: string; note?: string }
}

export interface StopsSectionActions {
  onState?: (state: StopState) => void
  onRetry?: () => void
  onShowUpdates?: () => void
  onDialog?: (dialog: StopDialog | null) => void
  onLift?: (stop: ReminderStop, reason: string) => void
  onChange?: (stop: ReminderStop, input: { until: string | null; note: string | null }) => void
  onExport?: (ids: string[]) => void
  onDismissNotice?: () => void
}

/**
 * Finance › Receivables › Reminder stops (design finance.receivables sec:reminders "Held (W2b stop rules): 'payment being
 * processed', 'dispute open', 'promise to pay', 'credit note pending'"; SCR-514): every stop of the company — the customer,
 * the invoice, why, its last day (a promise to pay holds until the day promised), the note, how many reminders it holds now,
 * who recorded it — in force, lifted, over or all (Rows ▾), on the shared list frame (select-all, shift range, x; Export N;
 * keys only in the footer's info icon). A stop in force is changed (its last day, its note) or lifted with why; a lifted or
 * finished stop never changes. Stops are recorded inside a reminder. No money in this section.
 */
export function StopsSection({ model, actions }: { model: StopsSectionModel; actions?: StopsSectionActions }) {
  return (
    <WithMessages namespaces={PAY_DEPTH_NAMESPACES}>
      <Section model={model} actions={actions} />
    </WithMessages>
  )
}

function Section({ model, actions }: { model: StopsSectionModel; actions?: StopsSectionActions }) {
  const p = useT(PAY_DEPTH)
  const t = useT('finance')
  const s = useScopedT('finance')
  const locale = useLocale()
  const say = (phrase: Phrase | null) => (phrase ? s(phrase.key, phrase.params) : null)
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  const rowsKey = model.stops?.map((row) => row.id).join(',') ?? ''
  useEffect(() => setSelected((current) => current.filter((id) => rowsKey.includes(id))), [rowsKey])
  const latest = useRef({ model, actions })
  latest.current = { model, actions }

  const columns = useMemo<ColDef<ReminderStop>[]>(() => {
    const day = (value: string) => formatDate(dayInstant(value), { locale })
    const CustomerCell = ({ data }: ICellRendererParams<ReminderStop>) =>
      data ? (
        <span className="fw-fin-cell">
          <span className="fw-fin-ellipsis">{data.customer.name}</span>
          <span className="fw-fin-cell-sub">
            <Link className="fw-fin-link" href={`${latest.current.model.prefix}/finance/invoices/${data.invoice.id}`}>
              {data.invoice.number ?? '—'}
            </Link>
          </span>
        </span>
      ) : null
    const ReasonCell = ({ data }: ICellRendererParams<ReminderStop>) =>
      data ? (
        <span className="fw-fin-cell">
          <span>{p(`stops.reason.${data.reason}`)}</span>
          {data.note && <span className="fw-fin-cell-sub fw-fin-ellipsis">{data.note}</span>}
        </span>
      ) : null
    const UntilCell = ({ data }: ICellRendererParams<ReminderStop>) => (data ? <span>{data.until ? day(data.until) : p('stops.untilLifted')}</span> : null)
    const StateCell = ({ data }: ICellRendererParams<ReminderStop>) =>
      data ? (
        <span className="fw-fin-cell">
          <Pill tone={STOP_TONE[data.state]}>{p(`stops.state.${data.state}`)}</Pill>
          {data.state === 'holding' && <span className="fw-fin-cell-sub">{p('stops.holds', { count: data.holdsReminders.length })}</span>}
          {data.state === 'lifted' && data.liftedAt && <span className="fw-fin-cell-sub">{p('stops.liftedOn', { date: formatDate(data.liftedAt, { locale }) })}</span>}
        </span>
      ) : null
    const ByCell = ({ data }: ICellRendererParams<ReminderStop>) =>
      data ? (
        <span className="fw-fin-cell">
          <span>{formatDateTime(data.createdAt, { locale })}</span>
          <span className="fw-fin-cell-sub">{data.createdBy?.name ?? p('riba.someone')}</span>
        </span>
      ) : null
    const MoreCell = ({ data }: ICellRendererParams<ReminderStop>) => {
      if (!data) return null
      const { model: current, actions: act } = latest.current
      const lift = stopMoveHeld(data, 'lift', current.can, current.busy)
      const change = stopMoveHeld(data, 'change', current.can, current.busy)
      return (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': p('stops.rowMenu', { invoice: data.invoice.number ?? '—' }) }}
          items={[
            { id: 'change', label: p('stops.change'), disabled: !!change, description: say(change) ?? undefined, onSelect: () => act?.onDialog?.({ kind: 'change', stop: data }) },
            { id: 'lift', label: p('stops.liftMenu'), disabled: !!lift, description: say(lift) ?? undefined, onSelect: () => act?.onDialog?.({ kind: 'lift', stop: data }) },
          ]}
        />
      )
    }
    return [
      { colId: 'customer', headerName: p('stops.col.customer'), minWidth: 180, flex: 1.3, cellRenderer: CustomerCell },
      { colId: 'reason', headerName: p('stops.col.reason'), minWidth: 180, flex: 1.3, cellRenderer: ReasonCell },
      { colId: 'until', headerName: p('stops.col.until'), minWidth: 130, flex: 0.8, cellRenderer: UntilCell },
      { colId: 'state', headerName: p('stops.col.state'), minWidth: 150, flex: 0.9, cellRenderer: StateCell },
      { colId: 'by', headerName: p('stops.col.by'), minWidth: 160, flex: 1, cellRenderer: ByCell },
      { colId: 'more', headerName: t('col.more'), minWidth: 72, maxWidth: 72, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
    // The cells read the latest model and actions through the ref, so the columns stay the same object between renders.
  }, [p, t, s, locale])

  const stops = model.stops
  const picked = (stops ?? []).filter((row) => selected.includes(row.id))
  const state = model.problem ? (
    <EmptyState title={p('stops.failedTitle')} description={t(model.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('common.retry')}</Button>} />
  ) : stops && stops.length === 0 ? (
    <EmptyState title={p(`stops.empty.${model.state}.title`)} description={p(`stops.empty.${model.state}.body`)} />
  ) : undefined
  const tools = (
    <Select size="sm" aria-label={p('stops.rowsLabel')} value={model.state} onChange={(event) => actions?.onState?.(event.target.value as StopState)}>
      {STOP_STATES.map((value) => (
        <option key={value} value={value}>
          {p(`stops.rows.${value}`)}
        </option>
      ))}
    </Select>
  )
  return (
    <section id="reminder-stops" className="fw-fin-section" aria-labelledby="fw-stops-title">
      <div className="fw-fin-section-head">
        <h2 id="fw-stops-title" className="fw-fin-h2">
          {p('stops.title')}
        </h2>
      </div>
      <p className="fw-fin-hint">{p('stops.body')}</p>
      {model.notice && (
        <Banner
          tone="success"
          title={say(model.notice) ?? ''}
          action={
            <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
              {t('common.dismiss')}
            </Button>
          }
        />
      )}
      <ListFrame<ReminderStop>
        label={p('stops.title')}
        rows={state ? [] : stops}
        rowId={(row) => row.id}
        columns={columns}
        count={stops ? p('stops.count', { count: stops.length }) : '—'}
        tools={tools}
        listKey="finance.receivables.stops"
        selection={{
          selected,
          onChange: setSelected,
          actions: (
            <Button size="sm" variant="primary" aria-label={t('bulk.export', { count: picked.length })} onClick={() => actions?.onExport?.(picked.map((row) => row.id))}>
              <Download size={13} aria-hidden /> <SelectionLabel>{t('bulk.export', { count: picked.length })}</SelectionLabel>
            </Button>
          ),
        }}
        updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
        state={state}
      />
      {model.dialog && <StopDialogView key={`${model.dialog.kind}-${model.dialog.stop.id}`} model={model} dialog={model.dialog} actions={actions} />}
    </section>
  )
}

function StopDialogView({ model, dialog, actions }: { model: StopsSectionModel; dialog: StopDialog; actions?: StopsSectionActions }) {
  const p = useT(PAY_DEPTH)
  const s = useScopedT('finance')
  const locale = useLocale()
  const [reason, setReason] = useState(model.draft?.reason ?? '')
  const [until, setUntil] = useState(model.draft?.until ?? dialog.stop.until ?? '')
  const [note, setNote] = useState(model.draft?.note ?? dialog.stop.note ?? '')
  const close = () => actions?.onDialog?.(null)
  const right = stopMoveHeld(dialog.stop, dialog.kind, model.can, false)
  if (dialog.kind === 'lift') {
    const held = right ? s(right.key, right.params) : model.busy ? s('common.working') : reason.length > MAX_STOP_TEXT.liftReason ? p('stops.held.reasonLong', { max: MAX_STOP_TEXT.liftReason }) : null
    return (
      <DialogFrame title={p('stops.liftTitle', { invoice: dialog.stop.invoice.number ?? '—' })} held={held} go={() => actions?.onLift?.(dialog.stop, reason.trim())} goLabel={p('stops.liftGo')} onClose={close} problem={model.writeProblem}>
        <p className="fw-fin-hint">{p('stops.liftBody', { reason: p(`stops.reason.${dialog.stop.reason}`), count: dialog.stop.holdsReminders.length })}</p>
        <Field label={p('stops.liftReason')} hint={p('stops.liftReasonHint')}>
          <Textarea value={reason} onChange={(event) => setReason(event.target.value)} maxLength={MAX_STOP_TEXT.liftReason} rows={2} />
        </Field>
      </DialogFrame>
    )
  }
  const promise = dialog.stop.reason === 'PROMISE_TO_PAY'
  const dayHeld = promise && until === '' ? p('stops.held.promiseDay') : until !== '' && until < model.today ? p('stops.held.dayPast') : null
  const held = right ? s(right.key, right.params) : model.busy ? s('common.working') : (dayHeld ?? (note.length > MAX_STOP_TEXT.note ? p('stops.held.noteLong', { max: MAX_STOP_TEXT.note }) : null))
  return (
    <DialogFrame title={p('stops.changeTitle', { invoice: dialog.stop.invoice.number ?? '—' })} held={held} go={() => actions?.onChange?.(dialog.stop, { until: until || null, note: note.trim() || null })} goLabel={p('stops.changeGo')} onClose={close} problem={model.writeProblem}>
      <Field label={promise ? p('stops.add.promiseDay') : p('stops.add.until')} hint={promise ? p('stops.add.promiseHint') : p('stops.add.untilHint')}>
        <DateField value={until} onChange={setUntil} min={model.today} locale={INTL_LOCALE[locale]} ariaLabel={p('stops.add.until')} />
      </Field>
      <Field label={p('stops.add.note')}>
        <Textarea value={note} onChange={(event) => setNote(event.target.value)} maxLength={MAX_STOP_TEXT.note} rows={3} />
      </Field>
    </DialogFrame>
  )
}
