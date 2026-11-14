'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { MoreHorizontal, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { Banner, Card, EmptyState, Field, KeyValue, Menu, SummaryTable } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Pill, Select, Skeleton } from '@nexus/ui/primitives'
import { Modal } from '../../../../../lib/i18n/ds-parts'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { listKeys, type ListKey } from '../../../../../list-frame/model'
import type { Phrase } from '../../../_shared/model'
import { DialogFrame } from '../../../_shared/parts'
import type { Currencies, Currency, RateDay, Rates } from '../api'
import {
  draftOf,
  draftProblems,
  draftWords,
  ecbOfDay,
  farFrom,
  manageHeld,
  plainRate,
  quoteChoices,
  RATE_PERIODS,
  ratesHeld,
  readHeld,
  rowSelectable,
  switchHeld,
  type CurrencyAbilities,
  type CurrencyProblem,
  type RateDialog,
  type RateDraft,
  type RatePeriod,
  type Read,
} from '../model'

export interface CurrenciesSectionModel {
  readonly can: CurrencyAbilities
  readonly currencies: Read<Currencies>
  readonly rates: Read<Rates>
  /** The rates table's currency (null: every one) and how many days back. */
  readonly quote: string | null
  readonly period: RatePeriod
  readonly dialog: RateDialog | null
  readonly dialogProblem: CurrencyProblem | null
  /** The manual rates asked to be removed (the confirmation open). */
  readonly removing: readonly RateDay[] | null
  readonly busy: boolean
  readonly notice: { readonly tone: 'success' | 'danger' | 'info' | 'warning'; readonly words: Phrase } | null
  /** Design cases: the starting selection, the draft of the dialog. */
  readonly selected?: readonly string[]
  readonly draft?: RateDraft
}

export interface CurrenciesSectionActions {
  onRetry?: () => void
  onQuote?: (quote: string | null) => void
  onPeriod?: (period: RatePeriod) => void
  onAdd?: (code: string) => void
  onSwitch?: (currency: Currency, active: boolean) => void
  onFeed?: (on: boolean) => void
  onReadNow?: () => void
  onDialog?: (dialog: RateDialog | null) => void
  onSaveRate?: (dialog: RateDialog, draft: RateDraft) => void
  onRemove?: (rows: readonly RateDay[] | null) => void
  onConfirmRemove?: () => void
  onDismissNotice?: () => void
}

/**
 * Finance › Settings › Currencies & rates (design finance.settings sec:currencies, B-W2b-389; PLT-132, PLT-133): the
 * company's own currency (its books and totals; changed in Admin › Companies & sites), the currencies its documents may be in with
 * the rate a document of today takes (or why one waits), the daily ECB rates (off until switched on; FAKE in test mode:
 * made-up rates) and the rates table on the shared list frame — per day the ECB's rate and the manual one side by side, the
 * one documents take, a manual rate far from the ECB's flagged — with "Set a rate for a day", correct, and remove (several
 * at once when selected). No money: rates only. Every action held says why. Fetches nothing.
 */
export function CurrenciesSection({ model, actions }: { model: CurrenciesSectionModel; actions?: CurrenciesSectionActions }) {
  return (
    <WithMessages namespaces={['finance-currencies', 'finance', 'lists']}>
      <Section model={model} actions={actions} />
    </WithMessages>
  )
}

function Section({ model, actions }: { model: CurrenciesSectionModel; actions?: CurrenciesSectionActions }) {
  const t = useT('finance-currencies')
  const f = useT('finance')
  const say = (words: Phrase | null) => (words ? t(words.key, words.params) : null)
  if (!model.can.view)
    return (
      <Card padded className="fw-fin-card fw-fin-card--wide">
        <h2 className="fw-fin-h2">{t('title')}</h2>
        <p className="fw-fin-hint">{t('noRight')}</p>
      </Card>
    )
  const loaded = model.currencies
  if (loaded.problem)
    return (
      <Card padded className="fw-fin-card fw-fin-card--wide">
        <EmptyState title={t('failed')} description={f(loaded.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{f('common.retry')}</Button>} />
      </Card>
    )
  if (!loaded.value)
    return (
      <Card padded className="fw-fin-card fw-fin-card--wide" aria-busy="true">
        <div className="fw-fin-stack-tight">
          <Skeleton width={200} height={18} />
          <Skeleton height={14} />
          <Skeleton height={14} />
          <Skeleton height={120} />
        </div>
      </Card>
    )
  const value = loaded.value
  return (
    <Card padded className="fw-fin-card fw-fin-card--wide">
      <div className="fw-fin-card-head">
        <h2 className="fw-fin-h2">{t('title')}</h2>
        {value.feed.mode === 'FAKE' && <Pill tone="warning">{t('feed.fake')}</Pill>}
      </div>
      <p className="fw-fin-hint">{t('explain')}</p>
      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={say(model.notice.words) ?? ''}
          action={
            actions?.onDismissNotice ? (
              <Button size="sm" variant="quiet" onClick={actions.onDismissNotice}>
                {f('common.dismiss')}
              </Button>
            ) : undefined
          }
        />
      )}
      <div className="fw-fin-cards fw-fin-cards--two">
        <DocumentCurrencies model={model} value={value} actions={actions} />
        <Feed model={model} value={value} actions={actions} />
      </div>
      <RatesTable model={model} value={value} actions={actions} />
      {model.dialog && <RateDialogView key={model.dialog.mode === 'correct' ? model.dialog.row.key : 'set'} model={model} value={value} dialog={model.dialog} actions={actions} />}
      {model.removing && (
        <DialogFrame
          title={t('remove.title', { count: model.removing.length })}
          held={say(ratesHeld(model.can, model.busy))}
          go={() => actions?.onConfirmRemove?.()}
          goLabel={model.busy ? f('common.working') : t('remove.go', { count: model.removing.length })}
          onClose={() => actions?.onRemove?.(null)}
          tone="danger"
          size="sm"
        >
          <p className="fw-fin-hint">{t('remove.body')}</p>
          <ul className="fw-fin-list">
            {model.removing.map((row) => (
              <li key={row.key}>{t('remove.row', { day: row.day, words: row.words })}</li>
            ))}
          </ul>
        </DialogFrame>
      )}
    </Card>
  )
}

function DocumentCurrencies({ model, value, actions }: { model: CurrenciesSectionModel; value: Currencies; actions?: CurrenciesSectionActions }) {
  const t = useT('finance-currencies')
  const locale = useLocale()
  const [adding, setAdding] = useState(value.offered[0] ?? '')
  const held = manageHeld(model.can, model.busy)
  const rateCell = (entry: Currency) => {
    if (entry.base) return <span className="fw-fin-hint">{t('currencies.isBase')}</span>
    if (!entry.active) return <span className="fw-fin-hint">{t('currencies.off')}</span>
    if (entry.rate)
      return (
        <span className="fw-fin-cell">
          <span className="fw-fin-code">{entry.rate.words}</span>
          <span className="fw-fin-cell-sub">{t(`source.${entry.rate.source}`)} · {formatDate(entry.rate.rateDate, { locale })}</span>
        </span>
      )
    return <Pill tone="warning">{t('currencies.waits')}</Pill>
  }
  return (
    <section className="fw-fin-stack-tight" aria-labelledby="fw-cur-documents">
      <h3 className="fw-fin-h3" id="fw-cur-documents">
        {t('currencies.title')}
      </h3>
      <KeyValue dense labelCase="sentence" items={[{ label: t('base.label'), value: <span className="fw-fin-code">{value.company.base}</span> }]} />
      <p className="fw-fin-hint">{t('base.explain')}</p>
      <SummaryTable
        label={t('currencies.title')}
        columns={[t('currencies.col.code'), t('currencies.col.today'), t('currencies.col.action')]}
        density="roomy"
        stackOnPhone
        rows={value.currencies.map((entry) => {
          const wait = switchHeld(entry, model.can, model.busy)
          return {
            id: entry.code,
            cells: [
              <span key="c" className="fw-fin-inline">
                <span className="fw-fin-code">{entry.code}</span>
                {entry.base && <Pill tone="info">{t('currencies.base')}</Pill>}
              </span>,
              <span key="r">{rateCell(entry)}</span>,
              entry.base ? (
                <span key="a" className="fw-fin-hint">
                  {t('currencies.alwaysOn')}
                </span>
              ) : (
                <Button key="a" size="sm" heldReason={wait ? t(wait.key, wait.params) : null} onClick={() => actions?.onSwitch?.(entry, !entry.active)} aria-label={t(entry.active ? 'currencies.switchOffOf' : 'currencies.switchOnOf', { code: entry.code })}>
                  {t(entry.active ? 'currencies.switchOff' : 'currencies.switchOn')}
                </Button>
              ),
            ],
          }
        })}
      />
      {value.currencies.some((entry) => entry.waits) && <p className="fw-fin-hint">{t('currencies.waitsExplain')}</p>}
      <div className="fw-fin-inline">
        <Select size="sm" aria-label={t('currencies.addLabel')} value={adding} disabled={value.offered.length === 0} onChange={(event) => setAdding(event.target.value)}>
          {value.offered.map((code) => (
            <option key={code} value={code}>
              {code}
            </option>
          ))}
        </Select>
        <Button size="sm" heldReason={held ? t(held.key, held.params) : adding === '' ? t('held.noneLeft') : null} onClick={() => actions?.onAdd?.(adding)}>
          <Plus size={14} aria-hidden /> {t('currencies.add')}
        </Button>
      </div>
    </section>
  )
}

function Feed({ model, value, actions }: { model: CurrenciesSectionModel; value: Currencies; actions?: CurrenciesSectionActions }) {
  const t = useT('finance-currencies')
  const locale = useLocale()
  const feed = value.feed
  const held = ratesHeld(model.can, model.busy)
  const readWait = readHeld(feed, model.can, model.busy)
  return (
    <section className="fw-fin-stack-tight" aria-labelledby="fw-cur-feed">
      <div className="fw-fin-card-head">
        <h3 className="fw-fin-h3" id="fw-cur-feed">
          {t('feed.title')}
        </h3>
        <Pill tone={feed.on ? 'success' : 'neutral'}>{t(`feed.status.${feed.status}`)}</Pill>
      </div>
      <p className="fw-fin-hint">{t('feed.explain')}</p>
      <KeyValue
        dense
        labelCase="sentence"
        columns={2}
        items={[
          { label: t('feed.lastDay'), value: feed.lastEcbDay ? formatDate(feed.lastEcbDay, { locale }) : t('feed.never') },
          { label: t('feed.lastOk'), value: feed.lastOkAt ? formatDateTime(feed.lastOkAt, { locale }) : t('feed.never') },
          ...(feed.mode ? [{ label: t('feed.mode'), value: t(`feed.modeValue.${feed.mode}`) }] : []),
          ...(feed.lastErrorAt ? [{ label: t('feed.lastError'), value: formatDateTime(feed.lastErrorAt, { locale }) }] : []),
        ]}
      />
      {feed.mode === 'FAKE' && <p className="fw-fin-hint">{t('feed.fakeExplain')}</p>}
      <span className="fw-fin-actions">
        <Button size="sm" variant={feed.on ? 'secondary' : 'primary'} heldReason={held ? t(held.key, held.params) : null} onClick={() => actions?.onFeed?.(!feed.on)}>
          {t(feed.on ? 'feed.switchOff' : 'feed.switchOn')}
        </Button>
        <Button size="sm" heldReason={readWait ? t(readWait.key, readWait.params) : null} onClick={() => actions?.onReadNow?.()}>
          <RefreshCw size={13} aria-hidden /> {t('feed.readNow')}
        </Button>
      </span>
    </section>
  )
}

function RatesTable({ model, value, actions }: { model: CurrenciesSectionModel; value: Currencies; actions?: CurrenciesSectionActions }) {
  const t = useT('finance-currencies')
  const f = useT('finance')
  const lists = useT('lists')
  const locale = useLocale()
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  const [help, setHelp] = useState(false)
  const rows = model.rates.value?.days ?? null
  const rowsKey = rows?.map((row) => row.key).join(',') ?? ''
  useEffect(() => setSelected((current) => current.filter((key) => rowsKey.split(',').includes(key))), [rowsKey])
  const latest = useRef({ can: model.can, actions, busy: model.busy })
  latest.current = { can: model.can, actions, busy: model.busy }
  const setHeld = ratesHeld(model.can, model.busy)

  const columns = useMemo<ColDef<RateDay>[]>(() => {
    const DayCell = ({ data }: ICellRendererParams<RateDay>) => (data ? <span>{formatDate(data.day, { locale })}</span> : null)
    const PairCell = ({ data }: ICellRendererParams<RateDay>) => (data ? <span className="fw-fin-code">{t('rates.pair', { base: data.base, quote: data.quote })}</span> : null)
    const EcbCell = ({ data }: ICellRendererParams<RateDay>) => (data ? <span className="fw-fin-num">{data.ecb ? plainRate(data.ecb.rate) : '—'}</span> : null)
    const ManualCell = ({ data }: ICellRendererParams<RateDay>) =>
      data ? (
        <span className="fw-fin-inline">
          <span className="fw-fin-num">{data.manual ? plainRate(data.manual.rate) : '—'}</span>
          {data.farFromEcb && <Pill tone="warning">{t('rates.far')}</Pill>}
        </span>
      ) : null
    const UsedCell = ({ data }: ICellRendererParams<RateDay>) =>
      data ? (
        <span className="fw-fin-inline">
          <span className="fw-fin-code">{data.words}</span>
          <Pill tone={data.source === 'MANUAL' ? 'info' : 'neutral'}>{t(`source.${data.source}`)}</Pill>
        </span>
      ) : null
    const MoreCell = ({ data }: ICellRendererParams<RateDay>) => {
      if (!data) return null
      const now = latest.current
      const wait = ratesHeld(now.can, now.busy)
      const reason = wait ? t(wait.key, wait.params) : undefined
      return (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('rates.rowMenu', { pair: `${data.base}/${data.quote}`, day: data.day }) }}
          items={[
            data.manual
              ? { id: 'correct', label: t('rates.correct'), disabled: !!wait, description: reason, onSelect: () => now.actions?.onDialog?.({ mode: 'correct', row: data }) }
              : { id: 'set', label: t('rates.setForDay'), disabled: !!wait, description: reason, onSelect: () => now.actions?.onDialog?.({ mode: 'set', quote: data.quote, day: data.day }) },
            ...(data.manual ? [{ id: 'remove', label: t('rates.remove'), tone: 'danger' as const, disabled: !!wait, description: reason, onSelect: () => now.actions?.onRemove?.([data]) }] : []),
          ]}
        />
      )
    }
    return [
      { colId: 'day', headerName: t('rates.col.day'), minWidth: 120, flex: 0.8, cellRenderer: DayCell },
      { colId: 'pair', headerName: t('rates.col.pair'), minWidth: 120, flex: 0.8, cellRenderer: PairCell },
      { colId: 'ecb', headerName: t('rates.col.ecb'), minWidth: 120, flex: 0.8, type: 'rightAligned', cellRenderer: EcbCell },
      { colId: 'manual', headerName: t('rates.col.manual'), minWidth: 170, flex: 1, type: 'rightAligned', cellRenderer: ManualCell },
      { colId: 'used', headerName: t('rates.col.used'), minWidth: 240, flex: 1.6, cellRenderer: UsedCell },
      { colId: 'more', headerName: f('col.more'), minWidth: 72, maxWidth: 72, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
  }, [t, f, locale])

  const picked = (rows ?? []).filter((row) => selected.includes(row.key) && row.manual)
  const ownKeys: ListKey[] = [{ keys: ['n'], does: t('rates.keySet') }]

  // n: "Set a rate for a day" — never while typing or inside a dialog.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.metaKey || event.ctrlKey || event.altKey || help || model.dialog || model.removing) return
      if (target && (target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]') || target.isContentEditable)) return
      if (event.key === 'n' && !setHeld) {
        event.preventDefault()
        actions?.onDialog?.({ mode: 'set' })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const state = model.rates.problem ? (
    <EmptyState title={t('rates.failed')} description={f(model.rates.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{f('common.retry')}</Button>} />
  ) : rows && rows.length === 0 ? (
    <EmptyState title={t('rates.empty.title')} description={t(value.feed.on ? 'rates.empty.bodyOn' : 'rates.empty.body')} action={<Button size="sm" heldReason={setHeld ? t(setHeld.key, setHeld.params) : null} onClick={() => actions?.onDialog?.({ mode: 'set' })}>{t('rates.set')}</Button>} />
  ) : undefined

  const quotes = [...new Set([...value.currencies.filter((entry) => !entry.base && entry.active).map((entry) => entry.code), ...(rows ?? []).map((row) => row.quote)])].sort()
  return (
    <section className="fw-fin-stack-tight" aria-labelledby="fw-cur-rates">
      <div className="fw-fin-card-head">
        <h3 className="fw-fin-h3" id="fw-cur-rates">
          {t('rates.title')}
        </h3>
        <Button size="sm" heldReason={setHeld ? t(setHeld.key, setHeld.params) : null} onClick={() => actions?.onDialog?.({ mode: 'set' })} aria-keyshortcuts="n">
          <Plus size={14} aria-hidden /> {t('rates.set')}
        </Button>
      </div>
      <p className="fw-fin-hint">{t('rates.explain')}</p>
      {model.rates.value?.truncated && <Banner tone="info" title={t('rates.truncated')} />}
      <ListFrame<RateDay>
        label={t('rates.title')}
        rows={state ? [] : rows}
        rowId={(row) => row.key}
        columns={columns}
        count={rows ? t('rates.count', { count: rows.length }) : '—'}
        tools={
          <span className="fw-fin-inline">
            <Select size="sm" aria-label={t('rates.quoteLabel')} value={model.quote ?? ''} onChange={(event) => actions?.onQuote?.(event.target.value === '' ? null : event.target.value)}>
              <option value="">{t('rates.allQuotes')}</option>
              {quotes.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </Select>
            <Select size="sm" aria-label={t('rates.periodLabel')} value={String(model.period)} onChange={(event) => actions?.onPeriod?.(Number(event.target.value) as RatePeriod)}>
              {RATE_PERIODS.map((days) => (
                <option key={days} value={days}>
                  {t('rates.period', { count: days })}
                </option>
              ))}
            </Select>
          </span>
        }
        listKey="finance.settings.rates"
        isRowSelectable={(row) => {
          const wait = rowSelectable(row)
          return wait ? t(wait.key, wait.params) : null
        }}
        selection={{
          selected,
          onChange: setSelected,
          actions: picked.length > 0 && (
            <Button size="sm" variant="primary" heldReason={setHeld ? t(setHeld.key, setHeld.params) : null} aria-label={t('rates.bulkRemove', { count: picked.length })} onClick={() => actions?.onRemove?.(picked)}>
              <Trash2 size={13} aria-hidden /> <SelectionLabel>{t('rates.bulkRemove', { count: picked.length })}</SelectionLabel>
            </Button>
          ),
        }}
        keys={ownKeys}
        onHelp={() => setHelp(true)}
        onOpen={(row) => (setHeld ? undefined : actions?.onDialog?.(row.manual ? { mode: 'correct', row } : { mode: 'set', quote: row.quote, day: row.day }))}
        state={state}
      />
      {help && (
        <Modal open onClose={() => setHelp(false)} title={f('list.keysTitle')} size="sm">
          <ul className="fw-fin-list">
            {listKeys(ownKeys, true).map((entry) => (
              <li key={entry.does}>
                <b>{entry.keys.join(' ')}</b> — {entry.does.startsWith('keys.') ? lists(entry.does) : entry.does}
              </li>
            ))}
          </ul>
        </Modal>
      )}
    </section>
  )
}

/**
 * Set or correct the manual rate of a day: the currency (the company's other currencies first), the day (today or before),
 * the rate (1 <base> = … <currency>, a comma or a dot), the words it reads as, the ECB's rate of that day beside it when
 * the table holds it, and a warning when the two are more than 5 % apart. It serves every company of the group.
 */
function RateDialogView({ model, value, dialog, actions }: { model: CurrenciesSectionModel; value: Currencies; dialog: RateDialog; actions?: CurrenciesSectionActions }) {
  const t = useT('finance-currencies')
  const f = useT('finance')
  const choices = quoteChoices(value)
  const base = value.company.base
  const [draft, setDraft] = useState<RateDraft>(model.draft ?? draftOf(dialog, value.today, choices[0] ?? ''))
  const problems = draftProblems(draft, base, value.today)
  const words = draftWords(draft, base)
  const ecb = dialog.mode === 'correct' ? (dialog.row.ecb?.rate ?? null) : ecbOfDay(model.rates.value, draft.quote, draft.day, base)
  const bad = Object.keys(problems).length > 0
  const wait = ratesHeld(model.can, model.busy)
  const held = wait ? t(wait.key, wait.params) : bad ? t('rates.problem.fix') : null
  const set = (patch: Partial<RateDraft>) => setDraft((current) => ({ ...current, ...patch }))
  return (
    <DialogFrame
      title={dialog.mode === 'correct' ? t('dialog.correctTitle', { pair: `${dialog.row.base}/${dialog.row.quote}`, day: dialog.row.day }) : t('dialog.setTitle')}
      held={held}
      go={() => actions?.onSaveRate?.(dialog, draft)}
      goLabel={model.busy ? f('common.working') : t('dialog.save')}
      onClose={() => actions?.onDialog?.(null)}
    >
      {model.dialogProblem && <Banner tone="danger" title={t(model.dialogProblem.key, model.dialogProblem.params)} />}
      <p className="fw-fin-hint">{t('dialog.explain', { base })}</p>
      <div className="fw-fin-two">
        <Field label={t('dialog.quote')} error={problems.quote ? t(problems.quote) : undefined}>
          <Select value={draft.quote} disabled={dialog.mode === 'correct'} onChange={(event) => set({ quote: event.target.value })}>
            {(choices.includes(draft.quote) || draft.quote === '' ? choices : [draft.quote, ...choices]).map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('dialog.day')} hint={t('dialog.dayHint')} error={problems.day ? t(problems.day) : undefined}>
          <Input type="date" value={draft.day} max={value.today} readOnly={dialog.mode === 'correct'} onChange={(event) => set({ day: event.target.value })} />
        </Field>
      </div>
      <Field label={t('dialog.rate', { base, quote: draft.quote || '…' })} hint={t('dialog.rateHint')} error={draft.rate && problems.rate ? t(problems.rate) : undefined}>
        <Input inputMode="decimal" value={draft.rate} onChange={(event) => set({ rate: event.target.value })} autoComplete="off" />
      </Field>
      <p className="fw-fin-hint" role="status">
        {words ? t('dialog.reads', { words }) : t('dialog.readsNone')}
      </p>
      {ecb !== null && <p className="fw-fin-hint">{t('dialog.ecb', { rate: plainRate(ecb) })}</p>}
      {farFrom(draft, ecb) && <Banner tone="warning" title={t('dialog.far')} />}
      <p className="fw-fin-hint">{t('dialog.everyCompany')}</p>
    </DialogFrame>
  )
}
