'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { Ban, Copy, Download, FileText, MoreHorizontal, Plus, Search } from 'lucide-react'
import { Banner, EmptyState, Field, KeyValue, Menu, MetricStrip } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, FilterChip, Input, Pill, RadioCard, Select, Spinner, Tag, TokenChip } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { listKeys, type ListKey } from '../../../../../list-frame/model'
import { formatDate, formatTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { previewHref, QUOTE_STATUSES, type QuoteListRow, type QuoteStatus } from '../../api'
import { activeFilterCount, APPROVAL_TONE, droppedWords, isExpiring, money, NO_FILTERS, percent, QUOTE_TILES, START_FROM, STATUS_TONE, tileOfFilters, warningWords } from '../../model'
import { DuplicateDialog } from '../../duplicate/view/DuplicateDialog'
import type { NewQuoteModel, QuotesListActions, QuotesListViewModel } from '../list-model'
import '../../quotes.css'

export type { QuotesListViewModel, QuotesListActions } from '../list-model'

/**
 * SCR-034 — Quotes (Sales; design sales.quotes, 00 §2.1 list frame): the saved-filter tiles (each puts its chips in the
 * filter row: one filter model you can see), the toolbar (search by number or customer reference, status, only mine;
 * the time it was read; live changes wait behind "n updates · Show" so rows never move under the cursor), the list
 * (a stacked card list on a phone) with each number a real link, and the New quote dialog (customer, contact, the
 * number it will get). Money follows the person's grains. Keys: c new quote, / search. It fetches nothing.
 */
export function QuotesListView({ model, actions }: { model: QuotesListViewModel; actions?: QuotesListActions }) {
  return (
    <WithMessages namespaces={['sales', 'lists']}>
      <QuotesList model={model} actions={actions} />
    </WithMessages>
  )
}

function QuotesList({ model, actions }: { model: QuotesListViewModel; actions?: QuotesListActions }) {
  const t = useT('sales')
  const lists = useT('lists')
  const locale = useLocale()
  const [query, setQuery] = useState(model.filters.q)
  useEffect(() => setQuery(model.filters.q), [model.filters.q])
  const typed = useRef(false)
  const latest = useRef({ model, actions })
  latest.current = { model, actions }
  useEffect(() => {
    if (!typed.current) return
    const timer = setTimeout(() => latest.current.actions?.onFilters?.({ ...latest.current.model.filters, q: query }), 300)
    return () => clearTimeout(timer)
  }, [query])
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  const [dialog, setDialog] = useState<'cancel' | 'help' | null>(null)
  // A new read (filters, Show updates) starts with nothing selected; the design cases set their own.
  const rowsKey = model.rows.items?.map((row) => row.id).join(',') ?? ''
  useEffect(() => setSelected((current) => current.filter((id) => rowsKey.includes(id))), [rowsKey])
  useEffect(() => setSelected(model.selected ?? []), [model.selected])

  // c: a new quote (00 §3.17) — never while typing or inside a dialog. The list frame keeps / j k x Enter ?.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.metaKey || event.ctrlKey || event.altKey || model.newQuote || dialog) return
      if (target && (target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]') || target.isContentEditable)) return
      if (event.key === 'c' && model.can.manage) {
        event.preventDefault()
        actions?.onNewQuote?.(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const pressed = tileOfFilters(model.filters)
  const items = model.rows.items
  const shown = useMemo(() => (items ? items.filter((row) => !model.filters.expiring || isExpiring(row, model.today)) : null), [items, model.filters.expiring, model.today])
  const filtered = activeFilterCount(model.filters) > 0
  const recordHref = useCallback((row: QuoteListRow) => `${model.prefix}/sales/quotes/${row.id}`, [model.prefix])
  const picked = (shown ?? []).filter((row) => selected.includes(row.id))
  const notCancellable = picked.filter((row) => !CANCELLABLE.has(row.status)).length
  const ownKeys: ListKey[] = [{ keys: ['c'], does: t('list.keyNew') }]

  const live = useRef({ actions, manage: model.can.manage })
  live.current = { actions, manage: model.can.manage }
  const columns = useMemo<ColDef<QuoteListRow>[]>(() => {
    const NumberCell = ({ data }: ICellRendererParams<QuoteListRow>) =>
      data ? (
        <span className="fw-ql-cell">
          <Link className="fw-ql-link" href={recordHref(data)}>
            {data.number}
          </Link>
          <span className="fw-ql-row-sub">{t('record.versionChip', { revision: data.revision })}</span>
        </span>
      ) : null
    const CustomerCell = ({ data }: ICellRendererParams<QuoteListRow>) =>
      data ? (
        <span className="fw-ql-cell">
          <span className="fw-ql-ellipsis">{data.partyName}</span>
          {data.customerRef && <span className="fw-ql-row-sub">{t('list.ref', { ref: data.customerRef })}</span>}
        </span>
      ) : null
    const StatusCell = ({ data }: ICellRendererParams<QuoteListRow>) => (data ? <Pill tone={STATUS_TONE[data.status]}>{t(`status.${data.status}`)}</Pill> : null)
    const MarginCell = ({ data }: ICellRendererParams<QuoteListRow>) =>
      data ? (
        <span className="fw-q-inline">
          {percent(data.marginPct, locale)}
          {data.marginFloorBreached ? <Tag tone="warning">{t('lines.belowFloor')}</Tag> : null}
        </span>
      ) : null
    const ApprovalCell = ({ data }: ICellRendererParams<QuoteListRow>) => (data?.approval ? <Pill tone={APPROVAL_TONE[data.approval]}>{t(`approvalStatus.${data.approval}`)}</Pill> : <span>—</span>)
    const ValidCell = ({ data }: ICellRendererParams<QuoteListRow>) =>
      data ? (
        data.validUntil ? (
          <span className="fw-q-inline">
            {formatDate(`${data.validUntil}T12:00:00Z`, { locale })}
            {isExpiring(data, model.today) && <Tag tone="warning">{t('list.expiringSoon')}</Tag>}
          </span>
        ) : (
          <span>—</span>
        )
      ) : null
    const MoreCell = ({ data }: ICellRendererParams<QuoteListRow>) =>
      data ? (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('list.rowMenu', { number: data.number }) }}
          items={[
            { id: 'open', label: t('list.open'), href: recordHref(data) },
            { id: 'tab', label: t('list.openNewTab'), href: recordHref(data), target: '_blank' },
            { id: 'pdf', label: t('action.previewPdf'), icon: <FileText size={14} aria-hidden />, href: previewHref(data.id, 'it'), target: '_blank' },
            // B-W2a-49 (SAL-155): a new draft copied from this quote, for this customer or another.
            {
              id: 'duplicate',
              label: t('action.duplicate'),
              icon: <Copy size={14} aria-hidden />,
              disabled: !live.current.manage,
              description: live.current.manage ? undefined : t('held.noManage'),
              onSelect: () => live.current.actions?.onDuplicateStart?.(data),
            },
          ]}
        />
      ) : null
    return [
      { colId: 'number', headerName: t('list.col.number'), field: 'number', minWidth: 130, flex: 1, cellRenderer: NumberCell },
      { colId: 'customer', headerName: t('list.col.customer'), field: 'partyName', minWidth: 180, flex: 2, cellRenderer: CustomerCell },
      { colId: 'status', headerName: t('list.col.status'), field: 'status', minWidth: 190, flex: 1, cellRenderer: StatusCell },
      { colId: 'units', headerName: t('list.col.units'), field: 'units', minWidth: 110, flex: 1, valueFormatter: (params) => (params.data ? t('list.units', { units: params.data.units, lines: params.data.lineCount }) : '') },
      ...(model.grains.price
        ? ([
            { colId: 'net', headerName: t('list.col.net'), field: 'netAmount', minWidth: 125, flex: 1, type: 'rightAligned', valueFormatter: (params) => (params.data ? money(params.data.netAmount, params.data.currency, locale) : '') },
            { colId: 'gross', headerName: t('list.col.gross'), field: 'grossAmount', minWidth: 110, flex: 1, type: 'rightAligned', valueFormatter: (params) => (params.data ? money(params.data.grossAmount, params.data.currency, locale) : '') },
          ] satisfies ColDef<QuoteListRow>[])
        : []),
      ...(model.grains.margin ? ([{ colId: 'margin', headerName: t('list.col.margin'), field: 'marginPct', minWidth: 150, flex: 1, cellRenderer: MarginCell }] satisfies ColDef<QuoteListRow>[]) : []),
      { colId: 'approval', headerName: t('list.col.approval'), field: 'approval', minWidth: 125, flex: 1, cellRenderer: ApprovalCell },
      { colId: 'valid', headerName: t('list.col.validUntil'), field: 'validUntil', minWidth: 130, flex: 1, cellRenderer: ValidCell },
      { colId: 'updated', headerName: t('list.col.updated'), field: 'updatedAt', minWidth: 125, flex: 1, valueFormatter: (params) => (params.value ? formatDate(params.value as string, { locale }) : '—') },
      { colId: 'more', headerName: t('list.col.more'), minWidth: 88, maxWidth: 88, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
    // The cells read the words, the language and the person's grains through the closure: a change rebuilds them.
  }, [t, locale, model.grains.price, model.grains.margin, model.today, recordHref])

  const state = model.rows.problem ? (
    <EmptyState title={t('list.failed')} description={t(model.rows.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('common.retry')}</Button>} />
  ) : shown && shown.length === 0 ? (
    filtered ? (
      <EmptyState title={t('list.noMatch.title')} description={t('list.noMatch.body')} action={<Button size="sm" onClick={() => actions?.onFilters?.(NO_FILTERS)}>{t('list.clearAll')}</Button>} />
    ) : (
      <EmptyState
        title={t('list.empty.title')}
        description={t(model.can.manage ? 'list.empty.body' : 'list.empty.bodyView')}
        action={
          model.can.manage ? (
            <Button size="sm" variant="primary" onClick={() => actions?.onNewQuote?.(true)}>
              {t('list.new')}
            </Button>
          ) : undefined
        }
      />
    )
  ) : undefined

  return (
    <div className="fw-ql">
      <div className="fw-ql-head">
        <div className="fw-ql-head-text">
          <p className="fw-q-hint">{t('list.intro')}</p>
          <span className="fw-ql-count" role="status">
            {model.asOf ? t('list.updated', { time: formatTime(model.asOf, { locale }) }) : t('list.notYet')}
          </span>
        </div>
        <Button size="sm" variant="primary" heldReason={model.can.manage ? null : t('held.noManage')} onClick={() => actions?.onNewQuote?.(true)} aria-keyshortcuts="c">
          <Plus size={14} aria-hidden /> {t('list.new')}
        </Button>
      </div>

      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={t(model.notice.key, model.notice.params)}
          action={
            actions?.onDismissNotice ? (
              <Button size="sm" variant="quiet" onClick={actions.onDismissNotice}>
                {t('common.dismiss')}
              </Button>
            ) : undefined
          }
        />
      )}

      <MetricStrip
        metrics={QUOTE_TILES.map((tile) => {
          const count = model.tiles[tile]
          const value = count.count === null ? '—' : count.more ? t('list.tileMore', { count: count.count }) : String(count.count)
          return {
            label: t(`list.tile.${tile}`),
            value,
            hint: tile === 'accepted' && model.grains.price && count.value !== undefined && count.value !== null ? money(count.value, 'EUR', locale) : undefined,
            onClick: () => actions?.onTile?.(tile),
            active: pressed === tile,
          }
        })}
      />

      {filtered && (
        <div className="fw-ql-chips" aria-label={t('list.activeFilters')}>
          {model.filters.status && (
            <TokenChip removeLabel={t('list.removeFilter')} onRemove={() => actions?.onFilters?.({ ...model.filters, status: null, expiring: false })}>
              {t('list.chip.status', { status: t(`status.${model.filters.status}`) })}
            </TokenChip>
          )}
          {model.filters.mine && (
            <TokenChip removeLabel={t('list.removeFilter')} onRemove={() => actions?.onFilters?.({ ...model.filters, mine: false })}>
              {t('list.onlyMine')}
            </TokenChip>
          )}
          {model.filters.expiring && (
            <TokenChip removeLabel={t('list.removeFilter')} onRemove={() => actions?.onFilters?.({ ...model.filters, expiring: false })}>
              {t('list.chip.expiring')}
            </TokenChip>
          )}
          {model.filters.q.trim() && (
            <TokenChip removeLabel={t('list.removeFilter')} onRemove={() => actions?.onFilters?.({ ...model.filters, q: '' })}>
              {t('list.chip.search', { q: model.filters.q.trim() })}
            </TokenChip>
          )}
          <Button size="sm" variant="quiet" onClick={() => actions?.onFilters?.(NO_FILTERS)}>
            {t('list.clearAll')}
          </Button>
        </div>
      )}

      <ListFrame<QuoteListRow>
        label={t('list.tableLabel')}
        rows={state ? [] : shown}
        rowId={(row) => row.id}
        columns={columns}
        count={shown ? t(model.rows.more ? 'list.countMore' : 'list.count', { count: shown.length }) : '—'}
        search={
          <Input
            size="sm"
            type="search"
            leadingIcon={<Search size={13} aria-hidden />}
            aria-label={t('list.search')}
            placeholder={t('list.search')}
            value={query}
            onChange={(event) => {
              typed.current = true
              setQuery(event.target.value)
            }}
          />
        }
        tools={
          <>
            <Select size="sm" aria-label={t('list.statusFilter')} value={model.filters.status ?? ''} onChange={(event) => actions?.onFilters?.({ ...model.filters, status: (event.target.value || null) as QuoteStatus | null, expiring: event.target.value === 'SENT' ? model.filters.expiring : false })}>
              <option value="">{t('list.allStatuses')}</option>
              {QUOTE_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {t(`status.${status}`)}
                </option>
              ))}
            </Select>
            <FilterChip pressed={model.filters.mine} onClick={() => actions?.onFilters?.({ ...model.filters, mine: !model.filters.mine })}>
              {t('list.onlyMine')}
            </FilterChip>
          </>
        }
        selection={{
          selected,
          onChange: setSelected,
          actions: (
            <>
              <Button size="sm" aria-label={t('list.bulk.export', { count: picked.length })} onClick={() => actions?.onExport?.(picked.map((row) => row.id))}>
                <Download size={13} aria-hidden /> <SelectionLabel>{t('list.bulk.export', { count: picked.length })}</SelectionLabel>
              </Button>
              <Button
                size="sm"
                variant="danger-outline"
                aria-label={t('list.bulk.cancel', { count: picked.length })}
                heldReason={!model.can.manage ? t('held.noManage') : notCancellable > 0 ? t('list.bulk.cancelHeld', { count: notCancellable }) : null}
                onClick={() => setDialog('cancel')}
              >
                <Ban size={13} aria-hidden /> <SelectionLabel>{t('list.bulk.cancel', { count: picked.length })}</SelectionLabel>
              </Button>
            </>
          ),
        }}
        updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
        more={model.rows.more && shown && shown.length > 0 ? { label: t('list.more'), onMore: () => actions?.onMore?.() } : null}
        keys={ownKeys}
        onHelp={() => setDialog('help')}
        onOpen={(row) => actions?.onOpen?.(row.id)}
        state={state}
        focusRow={model.focusRow}
      />
      {!model.grains.margin && <p className="fw-q-hint">{t('list.noMarginNote')}</p>}

      {model.newQuote && <NewQuoteDialog model={model.newQuote} actions={actions} />}
      {model.duplicate && <DuplicateDialog model={model.duplicate} canManage={model.can.manage} actions={actions} />}
      {dialog === 'cancel' && <CancelManyDialog rows={picked} busy={model.busy} actions={actions} onDone={() => setSelected([])} onClose={() => setDialog(null)} />}
      {dialog === 'help' && (
        <Modal open onClose={() => setDialog(null)} title={t('list.keysTitle')} size="sm">
          <ul className="fw-q-list">
            {listKeys(ownKeys, true).map((entry) => (
              <li key={entry.does}>
                <b>{entry.keys.join(' ')}</b> — {entry.does.startsWith('keys.') ? lists(entry.does) : entry.does}
              </li>
            ))}
          </ul>
        </Modal>
      )}
    </div>
  )
}

const CANCELLABLE: ReadonlySet<string> = new Set(['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT'])

/** Cancel several quotes: what it does to each, one reason for all (a sent quote needs one: its link says withdrawn). */
function CancelManyDialog({ rows, busy, actions, onDone, onClose }: { rows: readonly QuoteListRow[]; busy?: boolean; actions?: QuotesListActions; onDone: () => void; onClose: () => void }) {
  const t = useT('sales')
  const [reason, setReason] = useState('')
  const sent = rows.filter((row) => row.status === 'SENT').length
  const length = reason.trim().length
  const held = sent > 0 && length < 3 ? t('list.bulk.reasonNeeded', { count: sent }) : length > 500 ? t('dialog.held.long') : busy ? t('held.busy') : null
  const go = () => {
    if (held) return
    void actions?.onCancelMany?.(rows.map((row) => row.id), reason).then((done) => {
      if (done) {
        onDone()
        onClose()
      }
    })
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={t('list.bulk.cancelTitle', { count: rows.length })}
      size="md"
      footer={
        <>
          <Button onClick={onClose}>{t('common.back')}</Button>
          <Button variant="danger" heldReason={held} onClick={go}>
            {t('list.bulk.cancel', { count: rows.length })}
          </Button>
        </>
      }
    >
      <div className="fw-q-dialog">
        <p className="fw-q-hint">{t(sent > 0 ? 'list.bulk.cancelBodySent' : 'list.bulk.cancelBody', { count: sent })}</p>
        <ul className="fw-q-list">
          {rows.map((row) => (
            <li key={row.id}>
              {row.number} · {row.partyName} · {t(`status.${row.status}`)}
            </li>
          ))}
        </ul>
        <Field label={t('dialog.reason')} required={sent > 0}>
          <Textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={3} maxLength={500} />
        </Field>
      </div>
    </Modal>
  )
}

function NewQuoteDialog({ model, actions }: { model: NewQuoteModel; actions?: QuotesListActions }) {
  const t = useT('sales')
  const [query, setQuery] = useState('')
  const typed = useRef(false)
  const search = useRef(actions?.onNewSearch)
  search.current = actions?.onNewSearch
  useEffect(() => {
    if (!typed.current) return
    const timer = setTimeout(() => search.current?.(query), 250)
    return () => clearTimeout(timer)
  }, [query])
  const party = model.party
  const contacts = party?.contacts.filter((contact) => contact.status === 'ACTIVE') ?? []
  const blocked = party && party.status !== 'ACTIVE' ? t('newQuote.held.party', { status: t(`partyStatus.${party.status}`) }) : null
  const noIdentity = party && !party.taxIdentities.some((identity) => identity.current) ? t('newQuote.held.identity') : null
  const startFrom = model.startFrom ?? 'blank'
  const past = model.past ?? null
  const chosenPast = past?.results?.find((row) => row.id === past.chosenId) ?? null
  const pastHeld = startFrom === 'past' && !chosenPast ? t('newQuote.held.past') : null
  const held = !party ? t('newQuote.held.customer') : (blocked ?? noIdentity ?? pastHeld ?? (model.busy ? t('held.busy') : null))
  const create = () => {
    if (!held) actions?.onCreate?.()
  }
  // B-W2a-49: a copy said what it left out — shown before the new quote opens.
  const done = past?.done ?? null
  if (done) {
    return (
      <Modal
        open
        onClose={() => actions?.onNewQuote?.(false)}
        title={t('dup.doneTitle', { number: done.number })}
        size="md"
        footer={
          <Button variant="primary" onClick={() => actions?.onPastOpen?.(done.quoteId)}>
            {t('dup.open', { number: done.number })}
          </Button>
        }
      >
        <div className="fw-q-dialog">
          <p className="fw-q-hint" role="status">
            {t('dup.doneBody', { number: done.number, source: chosenPast?.number ?? '', count: done.lines })}
          </p>
          {done.dropped.length > 0 && (
            <Banner tone="warning" title={t('dup.droppedTitle', { count: done.dropped.length })}>
              <ul className="fw-q-list">
                {done.dropped.map((item) => {
                  const words = droppedWords(item)
                  return <li key={`${item.seq}-${item.size ?? ''}`}>{t(words.key, words.params)}</li>
                })}
              </ul>
            </Banner>
          )}
          {done.warnings.map((warning) => (
            <Banner key={warning} tone="info" title={t(warningWords(warning).key)} />
          ))}
        </div>
      </Modal>
    )
  }
  return (
    <Modal
      open
      onClose={() => actions?.onNewQuote?.(false)}
      title={t('newQuote.title')}
      size="md"
      footer={
        <>
          <Button onClick={() => actions?.onNewQuote?.(false)}>{t('common.back')}</Button>
          <Button variant="primary" heldReason={held} onClick={create} aria-keyshortcuts="Meta+Enter Control+Enter">
            {startFrom === 'past' && chosenPast ? t('newQuote.createFrom', { number: chosenPast.number }) : t('newQuote.create')}
          </Button>
        </>
      }
    >
      <div
        className="fw-q-dialog"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            create()
          }
        }}
      >
        {model.companies.length > 1 && (
          <Field label={t('newQuote.company')}>
            <Select value={model.companyId} onChange={(event) => actions?.onNewCompany?.(event.target.value)}>
              {model.companies.map((company) => (
                <option key={company.id} value={company.id}>
                  {company.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {!party ? (
          <>
            <Field label={t('newQuote.customer')} hint={t('newQuote.customerHint')}>
              <Input
                value={query}
                type="search"
                autoComplete="off"
                placeholder={t('newQuote.customerPlaceholder')}
                onChange={(event) => {
                  typed.current = true
                  setQuery(event.target.value)
                }}
              />
            </Field>
            {model.searchProblem ? (
              <Banner tone="danger" title={t(model.searchProblem)} />
            ) : (
              <fieldset className="fw-q-choices">
                <legend className="fw-q-legend" aria-live="polite">
                  {model.results === null ? t('newQuote.searching') : model.results.length === 0 ? t('newQuote.none') : t('newQuote.found', { count: model.results.length })}
                </legend>
                {model.results === null && <Spinner size={14} />}
                {(model.results ?? []).map((row) => (
                  <RadioCard
                    key={row.id}
                    variant="row"
                    name="fw-q-customer"
                    value={row.id}
                    checked={false}
                    onChange={() => actions?.onNewPick?.(row.id)}
                    title={row.legalName}
                    description={
                      <span className="fw-q-tags">
                        <span className="fw-q-hint">{[row.tradeName, row.code, row.vatNumber, row.city].filter(Boolean).join(' · ')}</span>
                        {row.status !== 'ACTIVE' && <Tag tone="danger">{t(`partyStatus.${row.status}`)}</Tag>}
                        {row.vies.state !== 'VALID' && row.taxMode === 'EU_B2B' && <Tag tone="warning">{t('newQuote.viesWarning')}</Tag>}
                      </span>
                    }
                  />
                ))}
              </fieldset>
            )}
          </>
        ) : (
          <>
            <div className="fw-q-chosen-head">
              <strong>{party.legalName}</strong>
              <Button size="sm" variant="quiet" onClick={() => actions?.onNewPick?.(null)}>
                {t('newQuote.change')}
              </Button>
            </div>
            <KeyValue
              dense
              labelCase="sentence"
              items={[
                { label: t('newQuote.code'), value: party.code },
                { label: t('newQuote.taxMode'), value: party.taxMode ? t(`taxMode.${party.taxMode}`) : '—' },
                { label: t('newQuote.vies'), value: t(`vies.${party.vies.state}`) },
              ]}
            />
            {blocked && <Banner tone="danger" title={blocked} />}
            {noIdentity && <Banner tone="danger" title={noIdentity} />}
            {party.warnings.length > 0 && <Banner tone="warning" title={t('newQuote.warnings', { count: party.warnings.length })} />}
            <Field label={t('newQuote.contact')} hint={t('newQuote.contactHint')}>
              {/* The customer list is gone once one is picked: the focus moves on to the contact, not to the page. */}
              <Select autoFocus value={model.contactId} onChange={(event) => actions?.onNewField?.('contactId', event.target.value)}>
                <option value="">{t('newQuote.contactDefault')}</option>
                {contacts.map((contact) => (
                  <option key={contact.id} value={contact.id}>
                    {contact.name}
                    {contact.email ? ` · ${contact.email}` : ` · ${t('terms.noEmail')}`}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('terms.customerRef')} hint={t('terms.customerRefHint')}>
              <Input value={model.customerRef} onChange={(event) => actions?.onNewField?.('customerRef', event.target.value)} maxLength={100} />
            </Field>
            <fieldset className="fw-q-radios">
              <legend className="fw-q-legend">{t('newQuote.startFrom')}</legend>
              {START_FROM.map((from) => (
                <RadioCard key={from} name="fw-q-start-from" value={from} checked={startFrom === from} selected={startFrom === from} onChange={() => actions?.onStartFrom?.(from)} title={t(`newQuote.from.${from}`)} description={t(`newQuote.fromBody.${from}`)} />
              ))}
            </fieldset>
            {startFrom === 'past' && past && <PastQuotes past={past} partyId={party.id} actions={actions} />}
          </>
        )}
        <p className="fw-q-hint" role="status">
          {model.number === undefined ? t('newQuote.numberLoading') : model.number === null ? t('newQuote.numberUnknown') : t('newQuote.number', { number: model.number })}
        </p>
        {model.problem && party && <Banner tone="danger" title={t(model.problem)} />}
      </div>
    </Modal>
  )
}

/** New quote › Start from a past quote (B-W2a-49): this customer's quotes first; a number finds any quote of the company. */
function PastQuotes({ past, partyId, actions }: { past: NonNullable<NewQuoteModel['past']>; partyId: string; actions?: QuotesListActions }) {
  const t = useT('sales')
  const [query, setQuery] = useState(past.query)
  const typed = useRef(false)
  const search = useRef(actions?.onPastSearch)
  search.current = actions?.onPastSearch
  useEffect(() => {
    if (!typed.current) return
    const timer = setTimeout(() => search.current?.(query), 250)
    return () => clearTimeout(timer)
  }, [query])
  return (
    <>
      <Field label={t('newQuote.pastSearch')} hint={t('newQuote.pastHint')}>
        <Input
          value={query}
          type="search"
          autoComplete="off"
          placeholder={t('newQuote.pastPlaceholder')}
          onChange={(event) => {
            typed.current = true
            setQuery(event.target.value)
          }}
        />
      </Field>
      {past.problem ? (
        <Banner tone="danger" title={t(past.problem)} />
      ) : (
        <fieldset className="fw-q-choices">
          <legend className="fw-q-legend" aria-live="polite">
            {past.results === null ? t('newQuote.searching') : past.results.length === 0 ? t('newQuote.pastNone') : t('newQuote.pastFound', { count: past.results.length })}
          </legend>
          {past.results === null && <Spinner size={14} />}
          {(past.results ?? []).map((row) => (
            <RadioCard
              key={row.id}
              variant="row"
              name="fw-q-past"
              value={row.id}
              checked={past.chosenId === row.id}
              selected={past.chosenId === row.id}
              onChange={() => actions?.onPastPick?.(row.id)}
              title={`${row.number} · ${row.partyName}`}
              description={
                <span className="fw-q-tags">
                  <span className="fw-q-hint">{t('newQuote.pastLine', { revision: row.revision, lines: row.lineCount, units: row.units })}</span>
                  <Tag tone={STATUS_TONE[row.status]}>{t(`status.${row.status}`)}</Tag>
                  {row.partyId !== partyId && <Tag tone="info">{t('newQuote.pastOther')}</Tag>}
                </span>
              }
            />
          ))}
        </fieldset>
      )}
    </>
  )
}
