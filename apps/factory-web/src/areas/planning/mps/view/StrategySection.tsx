'use client'

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Check, Search, SlidersHorizontal } from 'lucide-react'
import { EmptyState } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Select } from '@nexus/ui/primitives'
import { CellSaveMark } from '../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../lib/i18n/format'
import type { Locale } from '../../../../lib/i18n/locales'
import type { Translate } from '../../../../lib/i18n/messages'
import { ListFrame } from '../../../../list-frame/ListFrame'
import type { ListKey } from '../../../../list-frame/model'
import type { StrategyItem } from '../api'
import { BULK_MAX, cellHeld, colourRows, filtered, ITEM_KINDS, itemSub, STRATEGIES, type MpsControls } from '../model'
import type { MpsActions, MpsModel } from '../view-model'
import { Listbox } from '../../../../lib/i18n/ds-parts' // B-W2b-F41: the DS parts in the page's language

interface Words {
  readonly t: Translate
  readonly locale: Locale
}

interface CellContextValue {
  readonly model: MpsModel
  readonly actions?: MpsActions
  readonly words: Words
}
/** The cells read the page's marks through a context, so a save that ends re-renders the cell without re-mounting it. */
const CellContext = createContext<CellContextValue | null>(null)

/** Enter on a cell's own control is that control's. */
const onOwnControl = (): boolean => {
  if (typeof document === 'undefined') return false
  const active = document.activeElement as HTMLElement | null
  return !!active && (active.tagName === 'BUTTON' || active.tagName === 'INPUT' || active.tagName === 'SELECT')
}

/**
 * Production strategy per item (design planning.mps sec:strategy; PLN-061) on the shared list frame: item, strategy (the DS
 * Listbox in the cell saves by itself with its mark: one PUT with the row's version), the colours set apart, the reason and
 * when and by whom it last changed (from the audit), the hint the design says on screen. Ticked rows: Change strategy for N
 * (the review with every change, ReviewChangesModal, Undo). Without planning.strategy.manage the cells read only and the bulk
 * change is held with the reason. Pages of 100: Show more.
 */
export function StrategySection({ model, actions, words }: { model: MpsModel; actions?: MpsActions; words: Words }) {
  const { t } = words
  const page = model.list.status === 'ready' ? model.list.value : null
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  const itemsKey = page?.items.map((item) => item.item.id).join(',') ?? ''
  useEffect(() => setSelected((current) => current.filter((id) => itemsKey.includes(id))), [itemsKey])
  useEffect(() => {
    if (model.bulk === null && model.notice?.key === 'notice.bulkDone') setSelected([])
  }, [model.bulk, model.notice])
  const [query, setQuery] = useState(model.controls.q)
  useEffect(() => setQuery(model.controls.q), [model.controls.q])
  const typed = useRef(false)
  const latest = useRef(actions)
  latest.current = actions
  useEffect(() => {
    if (!typed.current) return
    const timer = setTimeout(() => latest.current?.onFilter?.({ q: query.trim() }), 300)
    return () => clearTimeout(timer)
  }, [query])

  const held = cellHeld(model.can)
  const columns = useMemo<ColDef<StrategyItem>[]>(() => {
    const plain = { sortable: false, suppressHeaderMenuButton: true } as const
    return [
      { ...plain, colId: 'item', headerName: t('col.item'), minWidth: 260, flex: 1.6, cellRenderer: ItemCell },
      { ...plain, colId: 'strategy', headerName: t('col.strategy'), minWidth: 230, flex: 1.1, cellRenderer: StrategyCell },
      { ...plain, colId: 'colours', headerName: t('col.colours'), minWidth: 170, flex: 1, cellRenderer: ColoursCell },
      { ...plain, colId: 'reason', headerName: t('col.reason'), minWidth: 200, flex: 1.3, cellRenderer: ReasonCell },
      { ...plain, colId: 'changed', headerName: t('col.changed'), minWidth: 220, flex: 1.2, cellRenderer: ChangedCell },
    ]
  }, [t])

  const keys: ListKey[] = [{ keys: ['Enter'], does: t('keys.edit') }]
  const picked = (page?.items ?? []).filter((item) => selected.includes(item.item.id))
  const bulkHeld = held ? t(held) : picked.length > BULK_MAX ? t('bulk.tooMany', { max: BULK_MAX }) : null

  let state: ReactNode = undefined
  if (model.list.status === 'error') {
    state = (
      <EmptyState
        title={t('list.error')}
        description={t(model.list.problem)}
        action={
          <Button size="sm" onClick={() => actions?.onRetry?.()}>
            {t('common.retry')}
          </Button>
        }
      />
    )
  } else if (page && page.items.length === 0) {
    state = filtered(model.controls) ? (
      <EmptyState
        title={t('list.noMatch')}
        description={t('list.noMatchBody')}
        action={
          <Button size="sm" onClick={() => actions?.onClearFilters?.()}>
            {t('common.clearFilters')}
          </Button>
        }
      />
    ) : (
      <EmptyState title={t('list.empty')} description={t('list.emptyBody')} />
    )
  }

  const filterSelect = <K extends 'kind' | 'strategy' | 'set'>(key: K, label: string, values: readonly string[], word: (value: string) => string) => (
    <Select size="sm" aria-label={label} value={model.controls[key] ?? ''} onChange={(event) => actions?.onFilter?.({ [key]: event.target.value || null } as Partial<MpsControls>)}>
      <option value="">{t(`filter.all.${key}`)}</option>
      {values.map((value) => (
        <option key={value} value={value}>
          {word(value)}
        </option>
      ))}
    </Select>
  )

  return (
    <CellContext.Provider value={{ model, actions, words }}>
      <ListFrame<StrategyItem>
        label={t('list.title')}
        listKey="planning.mps"
        title={t('list.title')}
        rows={state ? [] : (page?.items ?? null)}
        rowId={(item) => item.item.id}
        columns={columns}
        count={page ? t('list.count', { count: page.items.length }) : '—'}
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
            {filterSelect('kind', t('filter.kind'), ITEM_KINDS, (value) => t(`kind.${value}`))}
            {filterSelect('strategy', t('filter.strategy'), STRATEGIES, (value) => t(`strategy.${value}`))}
            {filterSelect('set', t('filter.setLabel'), ['set', 'default'], (value) => t(`filter.set.${value}`))}
          </>
        }
        selection={{
          selected,
          onChange: setSelected,
          actions: (
            <Button size="sm" variant="primary" aria-label={t('bulk.open', { count: picked.length })} heldReason={bulkHeld} onClick={() => actions?.onBulk?.(picked.map((item) => item.item.id))}>
              <SlidersHorizontal size={13} aria-hidden /> <SelectionLabel>{t('bulk.open', { count: picked.length })}</SelectionLabel>
            </Button>
          ),
        }}
        more={page && page.nextCursor ? { label: t(page.more === 'failed' ? 'list.moreFailed' : 'list.more'), onMore: () => actions?.onMore?.(), held: page.more === 'loading' ? t('list.moreLoading') : null } : null}
        updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
        keys={keys}
        onHelp={() => actions?.onKeys?.()}
        onOpen={(item) => {
          if (onOwnControl() || typeof document === 'undefined') return
          // Enter edits the row's strategy: the cell's Listbox opens.
          const row = document.querySelector(`.ag-row[row-id="${CSS.escape(item.item.id)}"] .ag-cell[col-id="strategy"] button`) as HTMLButtonElement | null
          row?.click()
          row?.focus()
        }}
        state={state}
        focusRow={model.focusRow}
        keysOpen={model.keysOpen}
      />
    </CellContext.Provider>
  )
}

function useCell(): CellContextValue | null {
  return useContext(CellContext)
}

function ItemCell({ data: item }: ICellRendererParams<StrategyItem>) {
  const cell = useCell()
  if (!item || !cell) return null
  const { t } = cell.words
  return (
    <span className="fw-mps-cell">
      <span className="fw-mps-ellipsis" title={`${item.item.code} · ${item.item.name}`}>
        {item.item.code} · {item.item.name}
      </span>
      <span className="fw-mps-sub fw-mps-ellipsis">{itemSub(item, t)}</span>
    </span>
  )
}

function StrategyCell({ data: item }: ICellRendererParams<StrategyItem>) {
  const cell = useCell()
  if (!item || !cell) return null
  const { model, actions, words } = cell
  const { t } = words
  const held = cellHeld(model.can)
  const mark = model.marks[item.item.id]
  const name = `${item.item.code} · ${item.item.name}`
  return (
    <span className="fw-mps-strategy">
      {held ? (
        <span className="fw-mps-ellipsis" title={t(held)}>
          {t(`strategy.${item.strategy}`)}
        </span>
      ) : (
        <Listbox
          size="xs"
          width="100%"
          ariaLabel={t('cell.strategy', { item: name })}
          value={item.strategy}
          disabled={mark?.state === 'saving'}
          options={STRATEGIES.map((strategy) => ({ value: strategy, label: t(`strategy.${strategy}`) }))}
          onChange={(value) => {
            if (value !== item.strategy) actions?.onCell?.(item.item.id, value as (typeof STRATEGIES)[number])
          }}
        />
      )}
      {!item.set && !mark && <span className="fw-mps-sub fw-mps-nowrap">{t('cell.default')}</span>}
      <Mark mark={mark} t={t} />
    </span>
  )
}

function Mark({ mark, t }: { mark: MpsModel['marks'][string] | undefined; t: Translate }) {
  if (!mark) return null
  if (mark.state === 'saving') return <CellSaveMark state="saving" />
  if (mark.state === 'saved')
    return (
      <span className="fw-mps-saved" role="img" aria-label={t('cell.saved')} title={t('cell.saved')}>
        <Check size={12} aria-hidden />
      </span>
    )
  const reason = t(mark.problem)
  return (
    <span className="fw-mps-refused" role="img" aria-label={reason} title={reason}>
      !
    </span>
  )
}

function ColoursCell({ data: item }: ICellRendererParams<StrategyItem>) {
  const cell = useCell()
  if (!item || !cell) return null
  const { t } = cell.words
  const colours = colourRows(item)
  if (colours.length === 0) return <span className="fw-mps-sub">{t('cell.allColours')}</span>
  const text = colours.map((row) => `${row.colour?.name ?? '—'}: ${t(`strategy.${row.strategy}`)}`).join(' · ')
  return (
    <span className="fw-mps-cell" title={text}>
      <span className="fw-mps-ellipsis">{t('cell.coloursApart', { count: colours.length })}</span>
      <span className="fw-mps-sub fw-mps-ellipsis">{text}</span>
    </span>
  )
}

function ReasonCell({ data: item }: ICellRendererParams<StrategyItem>) {
  const cell = useCell()
  if (!item || !cell) return null
  const { t } = cell.words
  const reason = item.lastChange?.reason ?? null
  return reason ? (
    <span className="fw-mps-ellipsis" title={reason}>
      {reason}
    </span>
  ) : (
    <span className="fw-mps-sub">{item.lastChange ? t('cell.noReason') : '—'}</span>
  )
}

function ChangedCell({ data: item }: ICellRendererParams<StrategyItem>) {
  const cell = useCell()
  if (!item || !cell) return null
  const { t, locale } = cell.words
  const change = item.lastChange
  if (!change) return <span className="fw-mps-sub">{item.set ? t('cell.changedUnknown') : t('cell.neverSet')}</span>
  const when = formatDateTime(change.at, { locale, timeZone: cell.model.timeZone })
  const what = t('cell.changedFrom', { from: t(`strategy.${change.from}`), to: t(`strategy.${change.to}`), by: change.by?.name ?? t('cell.someone') })
  return (
    <span className="fw-mps-cell" title={`${when} · ${what}`}>
      <span className="fw-mps-ellipsis">{when}</span>
      <span className="fw-mps-sub fw-mps-ellipsis">{what}</span>
    </span>
  )
}
