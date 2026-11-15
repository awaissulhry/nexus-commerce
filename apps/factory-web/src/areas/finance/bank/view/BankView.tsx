'use client'

import { useMemo, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { CheckCheck, Download, FileUp, ListFilter, MoreHorizontal, X } from 'lucide-react'
import { Banner, EmptyState, Menu, MetricStrip, type Metric } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, FilterChip, Pill, Tag } from '@nexus/ui/primitives'
import { AsOf, Modal } from '../../../../lib/i18n/ds-parts'
import { formatDate, formatTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { listKeys, type ListKey } from '../../../../list-frame/model'
import { WithMessages } from '../../../../record-panels/i18n'
import { dayInstant, money } from '../../_shared/model'
import { LINE_VIEWS, type BankLine, type BankStatement, type LineCounts, type LineView } from '../api'
import { BANK_NAMESPACES, bankHref, bestOf, CONFIDENCE_TONE, maskIban, paymentHref, sureOf, tilesOf, type BankAddress, type BankCan, type Phrase, type Tone } from '../model'
import { AcceptAllReview, type ReviewModel } from './AcceptAllReview'
import { ChooseDialog, type ChooseActions, type ChooseModel } from './ChooseDialog'
import { FiguresSection, type FiguresActions, type FiguresModel } from './FiguresSection'
import { ImportDialog, type ImportActions, type ImportModel } from './ImportDialog'
import { MatchPanel, type MatchActions, type MatchState } from './MatchPanel'
import { ReverseDialog, type ReverseActions, type ReverseModel } from './ReverseDialog'
import '../bank.css'

export type LiveState = 'connecting' | 'live' | 'offline'

export interface Part<T> {
  readonly value: T | null
  readonly problem: string | null
}

/** SCR-152 — Finance › Bank's view model (the view draws it and fetches nothing). */
export interface BankModel {
  readonly prefix: string
  readonly can: BankCan
  readonly today: string
  readonly address: BankAddress
  readonly counts: Part<LineCounts>
  /** The lines of the view (or of the statement); null while the first read runs. */
  readonly lines: { readonly rows: readonly BankLine[] | null; readonly problem: string | null; readonly slow: boolean; readonly more: boolean }
  /** `?statement=`: the statement whose lines are shown. */
  readonly statement: BankStatement['statement'] | null
  /** The line open beside the list (from the rows, or read alone for `?line=`). */
  readonly current: Part<BankLine>
  readonly match: MatchState
  readonly readAt: number | null
  readonly live: LiveState
  readonly updates: number
  readonly busy: boolean
  readonly notice: { readonly tone: Tone; readonly phrases: readonly Phrase[] } | null
  readonly review: ReviewModel | null
  readonly choose: ChooseModel | null
  readonly reverse: ReverseModel | null
  readonly importing: ImportModel | null
  readonly figures: FiguresModel
  /** Design cases: the rows chosen, the row focused, the keys panel open, the keys dialog open. */
  readonly selected?: readonly string[]
  readonly focusRow?: number
  readonly keysOpen?: boolean
  readonly help?: boolean
}

export interface BankActions {
  onAddress?: (next: Partial<BankAddress>) => void
  onRetry?: (part: 'counts' | 'lines' | 'current') => void
  onMore?: () => void
  onShowUpdates?: () => void
  onOpenLine?: (lineId: string) => void
  onRefresh?: () => void
  onExport?: (rows: readonly BankLine[]) => void
  onReview?: (rows: readonly BankLine[] | null) => void
  onDismissNotice?: () => void
  match?: MatchActions
  review?: { onSave: () => void; onClose: () => void }
  choose?: ChooseActions
  reverse?: ReverseActions
  importing?: ImportActions
  figures?: FiguresActions
}

/**
 * SCR-152 — Finance › Payables & bank › Bank (design finance.bank; FIN-130, FIN-132, FIN-135): the band (the last
 * statement's day as AsOf, when it was read, live; Import statement; ⋯ Look again for matches · Export the lines in view ·
 * Keyboard shortcuts), the tiles (saved filters: Lines to match, Sure matches to accept, Unmatched over 7 days — a tile
 * filters the lines), Match bank lines (the lines on the ONE list frame on the left — select with the header box,
 * shift-click, x; Accept N sure matches, Export N — and the MatchPanel on the right: the open line, its suggested invoices
 * with High · Medium · Low and the reasons in words; J / K, Enter accepts, s splits), Their figures vs ours (a B2B customer's
 * stated figures with every difference), and the pop-ups (Import a bank statement, Choose another / Split, Accept all High,
 * Take back). Amounts only with the price grain. No person is counted or totalled.
 */
export function BankView({ model, actions }: { model: BankModel; actions?: BankActions }) {
  return (
    <WithMessages namespaces={[...BANK_NAMESPACES]}>
      <BankPage model={model} actions={actions} />
    </WithMessages>
  )
}

function BankPage({ model, actions }: { model: BankModel; actions?: BankActions }) {
  const t = useT('finance-bank')
  const lists = useT('lists')
  const locale = useLocale()
  const [selectedOwn, setSelected] = useState<string[]>([])
  const [helpOwn, setHelp] = useState(false)
  const [focusNonce, setFocusNonce] = useState(0)
  const selected = model.selected ? [...model.selected] : selectedOwn
  const help = helpOwn || !!model.help
  const can = model.can
  const rows = model.lines.rows
  const phrase = (entry: Phrase) => t(entry.key, entry.params)
  const day = (value: string | null) => (value ? formatDate(dayInstant(value), { locale }) : '—')
  const currentId = model.current.value?.id ?? model.address.line

  const columns = useMemo<ColDef<BankLine>[]>(() => {
    const BookedCell = ({ data }: ICellRendererParams<BankLine>) =>
      data ? (
        <span className="fw-bank-cell">
          <Link className="fw-bank-link" href={bankHref(model.prefix, { ...model.address, line: data.id, importing: false, figures: null, correct: false })} tabIndex={-1} aria-current={data.id === currentId ? 'true' : undefined}>
            {day(data.bookedOn)}
          </Link>
          <span className="fw-bank-sub">{data.id === currentId ? t('lines.open') : data.valueOn && data.valueOn !== data.bookedOn ? t('lines.value', { date: day(data.valueOn) }) : t(`lines.direction.${data.direction}`)}</span>
        </span>
      ) : null
    const AmountCell = ({ data }: ICellRendererParams<BankLine>) =>
      data ? (
        <span className="fw-bank-cell is-end">
          <span className={`fw-bank-num${data.direction === 'OUT' ? ' is-out' : ''}`}>{money(data.amount === undefined ? null : data.amount, data.currency, locale)}</span>
          <span className="fw-bank-sub">{t(`lines.direction.${data.direction}`)}</span>
        </span>
      ) : null
    const ReferenceCell = ({ data }: ICellRendererParams<BankLine>) =>
      data ? (
        <span className="fw-bank-cell">
          <span className="fw-bank-ellipsis">{data.referenceText ?? '—'}</span>
          <span className="fw-bank-sub fw-bank-code">{data.bankReference ?? ''}</span>
        </span>
      ) : null
    const PayerCell = ({ data }: ICellRendererParams<BankLine>) =>
      data ? (
        <span className="fw-bank-cell">
          <span className="fw-bank-ellipsis">{data.counterpartyName ?? '—'}</span>
          <span className="fw-bank-sub fw-bank-code">{maskIban(data.counterpartyIban)}</span>
        </span>
      ) : null
    const MatchCell = ({ data }: ICellRendererParams<BankLine>) => {
      if (!data) return null
      if (data.accepted) {
        const accepted = data.accepted
        return (
          <span className="fw-bank-cell">
            <span className="fw-bank-inline">
              <Pill tone="success">{t('lines.matched')}</Pill>
              <span className="fw-bank-ellipsis">{accepted.party.code}</span>
            </span>
            {accepted.paymentId ? (
              <Link className="fw-bank-link fw-bank-sub" href={paymentHref(model.prefix, accepted.paymentId)} tabIndex={-1}>
                {t('lines.payment')}
              </Link>
            ) : (
              <span className="fw-bank-sub">{accepted.supplierInvoice ? t('lines.supplierInvoice', { number: accepted.supplierInvoice.number }) : '—'}</span>
            )}
          </span>
        )
      }
      const best = bestOf(data)
      if (!best) return <span className="fw-bank-sub">{data.suggestions.length > 0 ? t('lines.staleOnly') : t('lines.noSuggestion')}</span>
      return (
        <span className="fw-bank-cell">
          <span className="fw-bank-inline">
            <Pill tone={CONFIDENCE_TONE[best.confidence]}>{t(`confidence.${best.confidence}`)}</Pill>
            <span className="fw-bank-ellipsis">{best.party.code}</span>
          </span>
          <span className="fw-bank-sub">{data.suggestions.length > 1 ? t('lines.more', { count: data.suggestions.length - 1 }) : t(`reason.${best.reasons[0]?.code ?? 'CHOSEN_BY_PERSON'}`)}</span>
        </span>
      )
    }
    const AgeCell = ({ data }: ICellRendererParams<BankLine>) =>
      data ? (
        <span className={`fw-bank-cell${data.state === 'TO_MATCH' && data.ageDays > (model.counts.value?.oldAfterDays ?? 7) ? ' is-late' : ''}`}>
          <span>{t('lines.days', { count: data.ageDays })}</span>
        </span>
      ) : null
    return [
      { colId: 'booked', headerName: t('col.booked'), minWidth: 120, flex: 0.8, cellRenderer: BookedCell },
      ...(can.price ? [{ colId: 'amount', headerName: t('col.amount'), minWidth: 130, flex: 0.8, type: 'rightAligned', cellRenderer: AmountCell } satisfies ColDef<BankLine>] : []),
      { colId: 'reference', headerName: t('col.reference'), minWidth: 200, flex: 1.6, cellRenderer: ReferenceCell },
      { colId: 'payer', headerName: t('col.payer'), minWidth: 170, flex: 1.1, cellRenderer: PayerCell },
      { colId: 'match', headerName: t('col.match'), minWidth: 160, flex: 1, cellRenderer: MatchCell },
      { colId: 'age', headerName: t('col.age'), minWidth: 90, flex: 0.5, cellRenderer: AgeCell },
    ]
    // The cells close over the words, the grain, the open line and the address.
  }, [t, locale, model.prefix, model.address, model.counts.value?.oldAfterDays, can.price, currentId])

  if (!can.view) {
    return (
      <div className="fw-bank">
        <EmptyState title={t('noAccess.title')} description={t('noAccess.body')} />
      </div>
    )
  }

  const picked = (rows ?? []).filter((row) => selected.includes(row.id))
  const pickedSure = sureOf(picked, can)
  const sureInView = sureOf(rows ?? [], can)
  const importHeld = !can.import ? t('held.import') : !can.upload ? t('held.upload') : null
  const reviewHeld = (count: number) => (!can.match ? t('held.match') : !can.record ? t('held.record') : count === 0 ? t('held.noSure') : model.busy ? t('held.busy') : null)
  const lastStatement = model.counts.value?.lastStatementOn ?? null
  const ownKeys: ListKey[] = [
    { keys: ['j', 'k'], does: t('keys.lines') },
    { keys: ['Enter'], does: t('keys.open') },
    { keys: ['x'], does: t('keys.select') },
    { keys: ['Enter'], does: t('keys.accept') },
    { keys: ['s'], does: t('keys.split') },
  ]
  const tiles: Metric[] = tilesOf(model.counts.value).map((tile) => ({
    label: t(`tile.${tile.id}`),
    value: tile.count === null ? '—' : String(tile.count),
    hint: tile.id === 'OLD' ? t('tile.OLDHint', { days: model.counts.value?.oldAfterDays ?? 7 }) : t(`tile.${tile.id}Hint`),
    onClick: () => actions?.onAddress?.({ view: model.address.view === tile.id && !model.address.statement ? 'TO_MATCH' : tile.id, statement: null }),
    active: !model.address.statement && model.address.view === tile.id,
  }))
  const viewMenu = (
    <Menu
      label={
        <span className="fw-bank-inline">
          <ListFilter size={13} aria-hidden /> {t('lines.viewMenu', { view: t(`view.${model.address.view}`) })}
        </span>
      }
      triggerProps={{ 'aria-label': t('lines.viewMenuLabel') }}
      items={LINE_VIEWS.map((view: LineView) => ({ id: view, label: t(`view.${view}`), onSelect: () => actions?.onAddress?.({ view, statement: null }) }))}
    />
  )
  const statementChip = model.address.statement ? (
    <FilterChip pressed onClick={() => actions?.onAddress?.({ statement: null })} aria-label={t('statement.clear')}>
      {model.statement ? t('statement.chip', { name: model.statement.fileName, from: day(model.statement.periodStart), to: day(model.statement.periodEnd) }) : t('statement.chipReading')} <X size={12} aria-hidden />
    </FilterChip>
  ) : null
  const state: ReactNode = model.lines.problem ? (
    <EmptyState
      title={t('lines.failed')}
      description={t(model.lines.problem)}
      action={
        <Button size="sm" onClick={() => actions?.onRetry?.('lines')}>
          {t('common.retry')}
        </Button>
      }
    />
  ) : rows && rows.length === 0 ? (
    model.address.view === 'TO_MATCH' && !model.address.statement ? (
      <EmptyState title={t('lines.empty.title')} description={t('lines.empty.body')} />
    ) : (
      <EmptyState title={t('lines.none.title')} description={t('lines.none.body')} action={<Button size="sm" onClick={() => actions?.onAddress?.({ view: 'TO_MATCH', statement: null })}>{t('lines.none.back')}</Button>} />
    )
  ) : undefined

  return (
    <div className="fw-bank">
      <div className="fw-bank-band" role="group" aria-label={t('band.label')}>
        <span className="fw-bank-inline">
          <span className="fw-bank-muted">{t('band.lastStatement')}</span>
          {model.counts.value ? lastStatement ? <span>{day(lastStatement)}</span> : <span className="fw-bank-muted">{t('band.noStatement')}</span> : <AsOf at={null} />}
          <span className="fw-bank-muted">{model.readAt !== null ? t('band.readAt', { time: formatTime(model.readAt, { locale }) }) : t('band.reading')}</span>
          <Tag tone={model.live === 'live' ? 'success' : model.live === 'offline' ? 'warning' : 'neutral'}>{t(`live.${model.live}`)}</Tag>
        </span>
        <span className="fw-bank-inline">
          <Button size="sm" variant="primary" heldReason={importHeld} onClick={() => actions?.onAddress?.({ importing: true })}>
            <FileUp size={14} aria-hidden /> {t('band.import')}
          </Button>
          <Menu
            label={<MoreHorizontal size={16} aria-hidden />}
            align="right"
            triggerProps={{ 'aria-label': t('band.more') }}
            items={[
              { id: 'refresh', label: t('band.refresh'), disabled: !can.match, ...(!can.match ? { description: t('held.match') } : {}), onSelect: () => actions?.onRefresh?.() },
              { id: 'export', label: t('band.export', { count: rows?.length ?? 0 }), disabled: !rows || rows.length === 0, ...(!rows || rows.length === 0 ? { description: t('held.noRows') } : {}), onSelect: () => rows && actions?.onExport?.(rows) },
              { id: 'keys', label: t('band.keys'), onSelect: () => setHelp(true) },
            ]}
          />
        </span>
      </div>

      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={model.notice.phrases.map(phrase).join(' ')}
          action={
            <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
              {t('common.dismiss')}
            </Button>
          }
        />
      )}

      <section className="fw-bank-section" aria-labelledby="fw-bank-tiles">
        <h2 id="fw-bank-tiles" className="fw-bank-h2">
          {t('tile.title')}
        </h2>
        {model.counts.problem && !model.counts.value ? (
          <EmptyState
            title={t('tile.failed')}
            description={t(model.counts.problem)}
            action={
              <Button size="sm" onClick={() => actions?.onRetry?.('counts')}>
                {t('common.retry')}
              </Button>
            }
          />
        ) : (
          <MetricStrip metrics={tiles} minTileWidth={200} />
        )}
      </section>

      <section className="fw-bank-section" aria-labelledby="fw-bank-match">
        <div className="fw-bank-section-head">
          <h2 id="fw-bank-match" className="fw-bank-h2">
            {t('match.title')}
          </h2>
          <span className="fw-bank-muted">{can.price ? t('match.hint') : t('match.noPrice')}</span>
        </div>
        {model.lines.slow && !rows && !model.lines.problem && (
          <p className="fw-bank-muted" role="status">
            {t('lines.slow')}
          </p>
        )}
        <div className="fw-bank-match">
          <div className="fw-bank-match-lines">
            <ListFrame<BankLine>
              label={t('match.title')}
              listKey="finance.bank.lines"
              rows={state ? [] : rows}
              rowId={(row) => row.id}
              columns={columns}
              count={rows ? t('lines.count', { count: rows.length }) : '—'}
              tools={
                <>
                  {viewMenu}
                  {statementChip}
                </>
              }
              right={
                <Button size="sm" variant="tonal" heldReason={reviewHeld(sureInView.length)} onClick={() => actions?.onReview?.(null)}>
                  <CheckCheck size={13} aria-hidden /> {t('review.open', { count: sureInView.length })}
                </Button>
              }
              selection={{
                selected,
                onChange: setSelected,
                actions: (
                  <>
                    <Button size="sm" variant="primary" heldReason={reviewHeld(pickedSure.length)} aria-label={t('bulk.accept', { count: pickedSure.length })} onClick={() => actions?.onReview?.(picked)}>
                      <CheckCheck size={13} aria-hidden /> <SelectionLabel>{t('bulk.accept', { count: pickedSure.length })}</SelectionLabel>
                    </Button>
                    <Button size="sm" aria-label={t('bulk.export', { count: picked.length })} onClick={() => actions?.onExport?.(picked)}>
                      <Download size={13} aria-hidden /> <SelectionLabel>{t('bulk.export', { count: picked.length })}</SelectionLabel>
                    </Button>
                  </>
                ),
              }}
              updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
              more={model.lines.more ? { label: t('lines.more50'), onMore: () => actions?.onMore?.() } : null}
              keys={ownKeys}
              onHelp={() => setHelp(true)}
              onOpen={(row) => {
                actions?.onOpenLine?.(row.id)
                setFocusNonce((value) => value + 1)
              }}
              state={state}
              focusRow={model.focusRow}
              keysOpen={model.keysOpen}
            />
          </div>
          <MatchPanel model={model} focusNonce={focusNonce} actions={actions?.match} onRetry={() => actions?.onRetry?.('current')} />
        </div>
      </section>

      <FiguresSection model={model.figures} prefix={model.prefix} today={model.today} actions={actions?.figures} />

      {model.importing && <ImportDialog model={model.importing} can={can} actions={actions?.importing} />}
      {model.choose && <ChooseDialog model={model.choose} can={can} actions={actions?.choose} />}
      {model.reverse && <ReverseDialog model={model.reverse} prefix={model.prefix} actions={actions?.reverse} />}
      {model.review && <AcceptAllReview model={model.review} price={can.price} actions={actions?.review} />}

      {help && (
        <Modal open onClose={() => setHelp(false)} title={t('keys.title')} size="sm">
          <ul className="fw-bank-list">
            {listKeys(ownKeys, true).map((entry, index) => (
              <li key={`${entry.keys.join('+')}-${index}`}>
                <b>{entry.keys.map((key) => (key === 'click' ? lists('keys.click') : key)).join(' ')}</b> — {entry.does.startsWith('keys.') ? lists(entry.does) : entry.does}
              </li>
            ))}
          </ul>
        </Modal>
      )}
    </div>
  )
}
