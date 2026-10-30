'use client'

import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, Check, MoreHorizontal, PackagePlus, Search } from 'lucide-react'
import { Banner, EmptyState, Menu } from '@nexus/ui/components'
import type { ColDef, ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Pill, Select, Spinner, Tag } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import type { ListKey } from '../../../../../list-frame/model'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale } from '../../../../../lib/i18n/provider'
import { quantity } from '../../../../_shared/stock/model'
import { Qty } from '../../../../_shared/stock/parts'
import { LINE_FILTERS, type CountLine, type CountRecord, type LineFilter } from '../../api'
import { heldPhrase, LINE_STATE_TONE, lineState, typedText, typedValue } from '../../model'
import { KeysModal, PartState, say, useWords, type Words } from '../../parts'
import type { CellSave, CountRecordActions, CountRecordModel } from '../../view-model'

/**
 * Count › Lines (design warehouse.counts/rec:Count/lines, cn-lines): the expected snapshot against what was counted, one
 * row per stock key (location, material and colour, lot, hide) in the sheet's order, on the shared list frame. While the
 * count is COUNTING the Counted cell takes the number: Enter saves it and goes down to the next line, Tab and leaving the
 * cell save it too (autosave per cell: one line per request with its version), 0 is "not found", Esc puts the cell back,
 * ⌘Z takes the last typed count back. A recount asked for is typed in the same cell (the first count stays in the state
 * column). "Counted by" says You or the counting team, never another person's name. Read-only after it is submitted.
 */

interface CellContext {
  editable: boolean
  held: string | null
  cells: Readonly<Record<string, CellSave>>
  onType?: (line: CountLine, text: string) => void
}
const CountCellContext = createContext<CellContext>({ editable: false, held: null, cells: {} })

/** The next row's count field (Enter goes down, as a spreadsheet does). */
function focusNext(from: HTMLInputElement, step: 1 | -1) {
  const frame = from.closest('.fw-list')
  if (!frame) return
  const fields = Array.from(frame.querySelectorAll<HTMLInputElement>('input[data-count-cell="true"]'))
  const index = fields.indexOf(from)
  const next = fields[index + step]
  if (next) {
    next.focus()
    next.select()
  }
}

function CountCell({ data }: ICellRendererParams<CountLine>) {
  const context = useContext(CountCellContext)
  const t = useWords()
  const locale = useLocale()
  const saved = data ? typedValue(data) : null
  const shown = typedText(saved, locale)
  const [text, setText] = useState(shown)
  const focused = useRef(false)
  useEffect(() => {
    if (!focused.current) setText(shown)
  }, [shown])
  if (!data) return null
  const save = context.cells[data.id]
  if (!context.editable) {
    return <span className="fw-st-num">{saved === null ? '—' : quantity(saved, locale, 4)}</span>
  }
  const commit = () => {
    if (text.trim() === shown.trim()) return
    context.onType?.(data, text)
  }
  return (
    <span className="fw-cn-count">
      <Input
        size="sm"
        inputMode="decimal"
        aria-label={t(data.recount ? 'line.recountOf' : 'line.countOf', { seq: data.seq, item: data.item.code })}
        data-count-cell="true"
        data-dirty={text.trim() !== shown.trim() ? 'true' : 'false'}
        value={text}
        placeholder={data.recount ? t('line.recountHere') : t('line.countHere')}
        onFocus={(event) => {
          focused.current = true
          event.currentTarget.select()
        }}
        onBlur={() => {
          focused.current = false
          commit()
        }}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            commit()
            focusNext(event.currentTarget, event.shiftKey ? -1 : 1)
          } else if (event.key === 'Escape') {
            event.preventDefault()
            setText(shown)
          } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            commit()
            focusNext(event.currentTarget, event.key === 'ArrowDown' ? 1 : -1)
          }
        }}
      />
      <span className={`fw-cn-count-state ${save?.state ?? ''}`} aria-live="polite">
        {save?.state === 'saving' ? (
          <Spinner size={12} />
        ) : save?.state === 'saved' ? (
          <Check size={14} aria-label={t('line.saved')} />
        ) : save?.state === 'failed' ? (
          <AlertCircle size={14} aria-label={say(t, save.words) ?? ''} />
        ) : null}
      </span>
    </span>
  )
}

/** The words of the place, material and lot/hide of a line (shared with Differences and the Apply dialog). */
export function lineWords(t: Words, line: CountLine): { place: string; material: string; tag: string } {
  const material = `${line.item.code} · ${line.item.name}${line.colour ? ` · ${line.colour.name}` : ''}`
  const tag = line.hide ? t('line.hide', { code: line.hide.code }) : line.lot ? t('line.lot', { code: line.lot.code }) : '—'
  return { place: `${line.location.code} · ${line.location.name}`, material, tag }
}

export function LinesTab({ value, model, actions }: { value: CountRecord; model: CountRecordModel; actions?: CountRecordActions }) {
  const t = useWords()
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const [query, setQuery] = useState(model.lines.q)
  const [help, setHelp] = useState(!!model.helpOpen)
  const typed = useRef(false)
  const latest = useRef(actions)
  latest.current = actions
  useEffect(() => {
    if (!typed.current) return
    const timer = setTimeout(() => latest.current?.onLines?.({ q: query }), 300)
    return () => clearTimeout(timer)
  }, [query])

  const editable = value.status === 'COUNTING' && value.actions.record.allowed
  const held = say(t, heldPhrase(value, 'record', model.can))
  const context = useMemo<CellContext>(() => ({ editable, held, cells: model.cells, onType: actions?.onType }), [editable, held, model.cells, actions?.onType])

  const columns = useMemo<ColDef<CountLine>[]>(() => {
    const SeqCell = ({ data }: ICellRendererParams<CountLine>) =>
      data ? (
        <span className="fw-st-cell">
          <span className="fw-st-num">{data.seq}</span>
          {data.origin === 'ADDED' && <span className="fw-st-sub">{t('line.added')}</span>}
        </span>
      ) : null
    const PlaceCell = ({ data }: ICellRendererParams<CountLine>) =>
      data ? (
        <span className="fw-st-cell" title={data.location.name}>
          <span className="fw-cn-code">{data.location.code}</span>
          <span className="fw-st-sub">{data.location.name}</span>
        </span>
      ) : null
    const MaterialCell = ({ data }: ICellRendererParams<CountLine>) =>
      data ? (
        <span className="fw-st-cell" title={`${data.item.code} · ${data.item.name}`}>
          <span className="fw-st-ellipsis">{`${data.item.code} · ${data.item.name}`}</span>
          <span className="fw-st-sub">{data.colour ? `${data.colour.code} ${data.colour.name}` : t('line.noColour')}</span>
        </span>
      ) : null
    const TagCell = ({ data }: ICellRendererParams<CountLine>) =>
      data ? (
        <span className="fw-st-cell">
          <span className="fw-cn-code">{data.hide ? data.hide.code : (data.lot?.code ?? '—')}</span>
          {data.hide && data.lot && <span className="fw-st-sub">{t('line.lot', { code: data.lot.code })}</span>}
        </span>
      ) : null
    const ExpectedCell = ({ data }: ICellRendererParams<CountLine>) => (data ? <Qty value={data.expected} uom={data.item.uom} decimals={4} /> : null)
    const UnitCell = ({ data }: ICellRendererParams<CountLine>) =>
      data ? (
        <span className="fw-st-cell" title={data.hide ? t('line.hideArea', { area: quantity(data.hide.area, locale) }) : undefined}>
          <span>{t(`stock:uom.${data.item.uom}`)}</span>
          {data.hide && <span className="fw-st-sub">{quantity(data.hide.area, locale)}</span>}
        </span>
      ) : null
    const ByCell = ({ data }: ICellRendererParams<CountLine>) =>
      data ? (
        <span className="fw-st-cell" title={value.countTeam ?? undefined}>
          <span className="fw-st-ellipsis">{data.counted === null ? '—' : data.countedByYou ? t('line.byYou') : value.countTeam ? value.countTeam : t('line.byTeam')}</span>
          <span className="fw-st-sub">{data.countedAt ? formatDateTime(data.countedAt, place) : ''}</span>
        </span>
      ) : null
    const StateCell = ({ data }: ICellRendererParams<CountLine>) => {
      const cells = useContext(CountCellContext).cells
      if (!data) return null
      const state = lineState(data)
      const save = cells[data.id]
      const sub =
        save?.state === 'failed'
          ? say(t, save.words)
          : data.recount
            ? t('line.firstCount', { count: data.counted === null ? '—' : quantity(data.counted, locale, 4) })
            : state === 'differs' && data.difference
              ? t('line.difference', { difference: `${Number(data.difference) > 0 ? '+' : '−'}${quantity(Math.abs(Number(data.difference)), locale, 4)}` })
              : data.movedSinceSnapshot
                ? t('line.moved')
                : null
      return (
        <span className="fw-st-cell">
          <span>
            <Pill tone={save?.state === 'failed' ? 'danger' : LINE_STATE_TONE[state]}>{t(`line.state.${state}`)}</Pill>
          </span>
          {sub && (
            <span className={save?.state === 'failed' ? 'fw-st-sub fw-cn-danger' : 'fw-st-sub'} title={sub}>
              {sub}
            </span>
          )}
        </span>
      )
    }
    const MoreCell = ({ data }: ICellRendererParams<CountLine>) =>
      data && data.origin === 'ADDED' && editable ? (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('line.menu', { seq: data.seq }) }}
          items={[{ id: 'remove', label: t('line.remove'), onSelect: () => latest.current?.onRemoveLine?.(data) }]}
        />
      ) : null
    return [
      { colId: 'seq', headerName: t('line.col.seq'), minWidth: 70, maxWidth: 90, cellRenderer: SeqCell },
      { colId: 'place', headerName: t('line.col.place'), minWidth: 140, flex: 1, cellRenderer: PlaceCell },
      { colId: 'material', headerName: t('line.col.material'), minWidth: 190, flex: 1.6, cellRenderer: MaterialCell },
      { colId: 'tag', headerName: t('line.col.tag'), minWidth: 130, flex: 0.9, cellRenderer: TagCell },
      { colId: 'expected', headerName: t('line.col.expected'), minWidth: 110, flex: 0.7, type: 'rightAligned', cellRenderer: ExpectedCell },
      {
        colId: 'counted',
        headerName: t('line.col.counted'),
        minWidth: 130,
        flex: 0.8,
        cellRenderer: CountCell,
        // The field owns its keys (Enter down, arrows, Esc): the grid does not move the focus under it.
        suppressKeyboardEvent: (params) => (params.event.target as HTMLElement | null)?.dataset?.countCell === 'true',
      },
      { colId: 'unit', headerName: t('line.col.unit'), minWidth: 90, flex: 0.5, cellRenderer: UnitCell },
      { colId: 'by', headerName: t('line.col.by'), minWidth: 140, flex: 0.9, cellRenderer: ByCell },
      { colId: 'state', headerName: t('line.col.state'), minWidth: 160, flex: 1, cellRenderer: StateCell },
      { colId: 'more', headerName: t('col.actions'), minWidth: 64, maxWidth: 64, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
  }, [t, locale, model.timeZone, value.countTeam, editable])

  const places = usePlaces(model.lines.items)

  if (value.status === 'DRAFT') {
    const startHeld = say(t, heldPhrase(value, 'start', model.can))
    return (
      <EmptyState
        title={t('lines.draft')}
        description={t('lines.draftBody')}
        action={
          <Button size="sm" variant="primary" heldReason={startHeld} onClick={() => actions?.onStart?.()}>
            {t('step.start')}
          </Button>
        }
      />
    )
  }

  const lines = model.lines
  const failed = Object.entries(model.cells).filter(([, save]) => save.state === 'failed').length
  const filtered = lines.filter !== 'all' || lines.q.trim() !== '' || lines.locationId !== null
  const ownKeys: ListKey[] = [
    { keys: ['↵'], does: t('keys.enterDown') },
    { keys: ['0'], does: t('keys.zero') },
    { keys: ['Esc'], does: t('keys.escape') },
    { keys: ['⌘', 'Z'], does: t('keys.undo') },
  ]
  const state = lines.problem ? (
    <PartState problem={lines.problem} loading={false} label={t('tab.lines')} onRetry={actions?.onRetryLines} />
  ) : lines.items && lines.items.length === 0 ? (
    filtered ? (
      <EmptyState
        title={t('lines.noMatch')}
        description={t('stock:common.noMatch')}
        action={
          <Button
            size="sm"
            onClick={() => {
              setQuery('')
              actions?.onLines?.({ filter: 'all', q: '', locationId: null })
            }}
          >
            {t('stock:common.clearFilters')}
          </Button>
        }
      />
    ) : (
      <EmptyState title={t('lines.empty')} description={t('lines.emptyBody')} />
    )
  ) : undefined

  return (
    <div className="fw-cn-stack">
      {editable ? (
        <p className="fw-cn-hint">{t('lines.howTo')}</p>
      ) : (
        held && <Banner tone="info" title={held} />
      )}
      {failed > 0 && <Banner tone="danger" title={t('lines.failed', { count: failed })} />}
      <CountCellContext.Provider value={context}>
        <ListFrame<CountLine>
          label={t('lines.tableLabel', { number: value.number })}
          rows={state ? [] : lines.items}
          rowId={(line) => line.id}
          columns={columns}
          count={lines.items ? t('lines.count', { counted: value.summary.counted, all: value.summary.lines }) : '—'}
          search={
            <Input
              size="sm"
              type="search"
              leadingIcon={<Search size={13} aria-hidden />}
              aria-label={t('lines.search')}
              placeholder={t('lines.search')}
              value={query}
              onChange={(event) => {
                typed.current = true
                setQuery(event.target.value)
              }}
            />
          }
          tools={
            <>
              <Select size="sm" aria-label={t('lines.filterLabel')} value={lines.filter} onChange={(event) => actions?.onLines?.({ filter: event.target.value as LineFilter })}>
                {LINE_FILTERS.map((filter) => (
                  <option key={filter} value={filter}>
                    {t(`lines.filter.${filter}`)}
                  </option>
                ))}
              </Select>
              {places.length > 1 && (
                <Select size="sm" aria-label={t('lines.placeLabel')} value={lines.locationId ?? ''} onChange={(event) => actions?.onLines?.({ locationId: event.target.value || null })}>
                  <option value="">{t('lines.allPlaces')}</option>
                  {places.map((item) => (
                    <option key={item.id} value={item.id}>
                      {`${item.code} · ${item.name}`}
                    </option>
                  ))}
                </Select>
              )}
            </>
          }
          right={
            editable ? (
              <Button size="sm" onClick={() => actions?.onOpenFound?.()}>
                <PackagePlus size={14} aria-hidden /> {t('found.open')}
              </Button>
            ) : (
              <Tag tone="neutral">{t('lines.readOnly')}</Tag>
            )
          }
          more={lines.more && lines.items && lines.items.length > 0 ? { label: t('list.showMore'), onMore: () => actions?.onMoreLines?.() } : null}
          keys={ownKeys}
          onHelp={() => setHelp(true)}
          state={state}
        />
      </CountCellContext.Provider>
      {model.undo && editable && <p className="fw-cn-hint">{t('lines.undoHint', { seq: model.undo.seq })}</p>}
      {help && <KeysModal own={ownKeys} withSelection={false} onClose={() => setHelp(false)} />}
    </div>
  )
}

/** The places the lines read so far sit at (the place filter's choices, kept while a filter narrows the lines). */
function usePlaces(items: readonly CountLine[] | null) {
  const seen = useRef(new Map<string, { id: string; code: string; name: string }>())
  return useMemo(() => {
    for (const line of items ?? []) if (!seen.current.has(line.location.id)) seen.current.set(line.location.id, line.location)
    return [...seen.current.values()].sort((a, b) => a.code.localeCompare(b.code))
  }, [items])
}
