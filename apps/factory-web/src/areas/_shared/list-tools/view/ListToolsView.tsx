'use client'

import { useMemo, useRef, useState } from 'react'
import { MoreHorizontal, Search } from 'lucide-react'
import { EmptyState, Menu } from '@nexus/ui/components'
import type { ColDef, ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Pill, Select } from '@nexus/ui/primitives'
import type { BulkValue } from '@nexus/factory-domain/views/bulk/rules'
import { inRange, isRelativeDay, ME, relativeRange } from '@nexus/factory-domain/views/quick/relative'
import { formatDate } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { ListToolsContext } from '../../../../list-frame/tools/transport'
import { modeOfAddress, withMode, type ListEdit, type ListMode, type ListQuick } from '../../../../list-frame/w2b/model'
import { memoryStore, memoryTransport, type MemoryToolsModel } from '../memory'

/**
 * SCR-232 — List tools (design shell.lists; PLT-163, PLT-179; W2b: PLT-164…167, PLT-170, PLT-182): the toolbar's
 * Columns ▾ (saved views: mine, shared with a role or everyone, a role's default; Save view as…, Update, Rename or
 * share, Copy link, Remove; Customise columns…; freeze the first column; the rows' density; the columns hidden by
 * rights) and Export ▾, and the W2b frame — Table · Board · Calendar · Cards, quick filters with "me" and relative
 * days, inline edit of the promised day and the priority with their save marks, Edit N with its review and Undo,
 * Export N of the selected rows — in the ONE list frame every Office list uses: here over a made-up list of sales
 * orders and the tools in memory, so every menu and dialog works in the browser. The list's own filters (Rows ▾, the
 * search, the quick filters, the mode) are its address terms: a view keeps them.
 */

export interface DemoOrder {
  readonly id: string
  readonly number: string
  readonly customer: string
  readonly status: 'CONFIRMED' | 'IN_PRODUCTION' | 'READY' | 'SHIPPED'
  readonly promised: string
  readonly late: boolean
  /** Minor units (cents); the price grain. */
  readonly net: number
  /** B-W2b-13 (made-up): the order's priority, edited in the grid. */
  readonly priority: number
  /** B-W2b-13 (made-up): who follows the order ("me" for the demo reader). */
  readonly owner: string
  readonly version: number
}

export interface ListToolsModel {
  readonly tools: MemoryToolsModel
  readonly rows: readonly DemoOrder[]
  /** The page's address terms when it opens (`late=true&q=demo`). */
  readonly query: string
  /** The reader holds the price grain (the Net column is there). */
  readonly price: boolean
  /** B-W2b-13: the W2b frame (modes, cards, edit, quick filters, export of the selection) is on. */
  readonly w2b?: boolean
  /** The reader may not change orders: cells read only, Edit N held. */
  readonly editHeld?: boolean
  /** The rows are still being read. */
  readonly loading?: boolean
  /** Rows selected when the case opens. */
  readonly selected?: readonly string[]
  /** The site's day of the demo (relative days count from it). */
  readonly today?: string
  /** The calendar's day open, the bulk edit open at a step. */
  readonly design?: { day?: string | null; bulk?: { values?: Record<string, BulkValue>; review?: boolean } }
}

const ROWS = ['open', 'late', 'all'] as const
type Rows = (typeof ROWS)[number]
const TONE = { CONFIRMED: 'info', IN_PRODUCTION: 'warning', READY: 'success', SHIPPED: 'neutral' } as const
const STATUSES = ['CONFIRMED', 'IN_PRODUCTION', 'READY', 'SHIPPED'] as const
const MODES: readonly ListMode[] = ['table', 'board', 'calendar', 'cards']
const DEMO_TODAY = '2026-11-11'

export function ListToolsView({ model }: { model: ListToolsModel }) {
  return (
    <WithMessages namespaces={['lists']}>
      <Demo model={model} />
    </WithMessages>
  )
}

function Demo({ model }: { model: ListToolsModel }) {
  const t = useT('lists')
  const locale = useLocale()
  const [query, setQuery] = useState(model.query)
  const store = useRef(memoryStore(model.tools))
  const transport = useMemo(() => memoryTransport(model.tools, store.current, query, setQuery), [model.tools, query])
  const [data, setData] = useState<readonly DemoOrder[]>(model.rows)
  const terms = new URLSearchParams(query)
  const rows: Rows = terms.get('late') === 'true' ? 'late' : terms.get('rows') === 'all' ? 'all' : 'open'
  const q = terms.get('q') ?? ''
  const today = model.today ?? DEMO_TODAY
  const set = (next: { rows?: Rows; q?: string }) => {
    const params = new URLSearchParams(query)
    params.delete('late')
    params.delete('rows')
    params.delete('q')
    const r = next.rows ?? rows
    if (r === 'late') params.set('late', 'true')
    if (r === 'all') params.set('rows', 'all')
    const text = (next.q ?? q).trim()
    if (text) params.set('q', text)
    setQuery(params.toString())
  }
  const promisedWord = terms.get('promised')
  const owner = terms.get('owner')
  const shown = data.filter(
    (row) =>
      (rows === 'late' ? row.late : rows === 'open' ? row.status !== 'SHIPPED' : true) &&
      (q === '' || `${row.number} ${row.customer}`.toLowerCase().includes(q.toLowerCase())) &&
      (!model.w2b || !isRelativeDay(promisedWord) || inRange(row.promised, relativeRange(promisedWord, today))) &&
      (!model.w2b || owner !== ME || row.owner === ME),
  )
  const [selected, setSelected] = useState<string[]>([...(model.selected ?? [])])
  const mode = modeOfAddress(terms, model.w2b ? MODES : ['table'])

  const columns = useMemo<ColDef<DemoOrder>[]>(() => {
    const money = new Intl.NumberFormat(locale === 'en' ? 'en-GB' : 'it-IT', { style: 'currency', currency: 'EUR' })
    const MoreCell = ({ data: row }: ICellRendererParams<DemoOrder>) =>
      row ? <Menu label={<MoreHorizontal size={16} aria-hidden />} align="right" triggerProps={{ 'aria-label': t('tools.demo.rowMenu', { number: row.number }) }} items={[{ id: 'open', label: t('tools.demo.open'), href: `#${row.id}` }]} /> : null
    return [
      { colId: 'number', headerName: t('tools.demo.col.number'), field: 'number', minWidth: 130, flex: 1, cellRenderer: ({ data: row }: ICellRendererParams<DemoOrder>) => (row ? <a href={`#${row.id}`}>{row.number}</a> : null) },
      { colId: 'customer', headerName: t('tools.demo.col.customer'), field: 'customer', minWidth: 170, flex: 1.5 },
      { colId: 'status', headerName: t('tools.demo.col.status'), field: 'status', minWidth: 130, flex: 0.9, valueFormatter: ({ value }: { value: DemoOrder['status'] }) => t(`tools.demo.status.${value}`), cellRenderer: ({ data: row }: ICellRendererParams<DemoOrder>) => (row ? <Pill tone={TONE[row.status]}>{t(`tools.demo.status.${row.status}`)}</Pill> : null) },
      { colId: 'promised', headerName: t('tools.demo.col.promised'), field: 'promised', minWidth: 140, flex: 0.9, valueFormatter: ({ value }: { value: string }) => formatDate(`${value}T12:00:00Z`, { locale }) },
      ...(model.w2b ? [{ colId: 'priority', headerName: t('tools.demo.col.priority'), field: 'priority' as const, minWidth: 96, flex: 0.5, type: 'rightAligned' }] : []),
      ...(model.price ? [{ colId: 'net', headerName: t('tools.demo.col.net'), field: 'net' as const, minWidth: 110, flex: 0.8, type: 'rightAligned', valueFormatter: ({ value }: { value: number }) => money.format(value / 100) }] : []),
      { colId: 'more', headerName: t('tools.demo.col.more'), minWidth: 64, maxWidth: 64, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
  }, [t, locale, model.price, model.w2b])

  const shipped = t('tools.demo.held.shipped')
  const edit = useMemo<ListEdit<DemoOrder>>(
    () => ({
      fields: {
        promised: { kind: 'date', valueOf: (row) => row.promised, held: (row) => (row.status === 'SHIPPED' ? shipped : null) },
        priority: { kind: 'integer', min: 0, max: 9, valueOf: (row) => row.priority, held: (row) => (row.status === 'SHIPPED' ? shipped : null) },
      },
      versionOf: (row) => row.version,
      labelOf: (row) => row.number,
      onSaved: (rowId, after, version) => setData((current) => current.map((row) => (row.id === rowId ? { ...row, ...(after as Partial<DemoOrder>), version } : row))),
      bulk: { noun: { one: t('tools.demo.noun_one'), other: t('tools.demo.noun_other') } },
      held: model.editHeld ? t('tools.demo.held.noRight') : null,
    }),
    [t, shipped, model.editHeld],
  )

  const quick = useMemo<ListQuick>(
    () => ({
      filters: [
        { id: 'owner', kind: 'me', label: t('tools.demo.quick.mine') },
        { id: 'promised', kind: 'date', label: t('tools.demo.quick.promised'), choices: ['today', 'this-week', 'next-7-days', 'overdue'] },
      ],
      values: { owner, promised: promisedWord },
      onChange: (id, value) => {
        const params = new URLSearchParams(query)
        if (value) params.set(id, value)
        else params.delete(id)
        setQuery(params.toString())
      },
    }),
    [t, owner, promisedWord, query],
  )

  const counts = Object.fromEntries(STATUSES.map((status) => [status, shown.filter((row) => row.status === status).length]))
  const w2b = model.w2b
    ? {
        modes: {
          mode,
          onMode: (next: ListMode) => setQuery(withMode(query, next)),
          board: {
            lanes: STATUSES.map((status) => ({ id: status, label: t(`tools.demo.status.${status}`), total: counts[status] ?? 0, ...(status === 'SHIPPED' ? { held: t('tools.demo.held.ship') } : {}) })),
            laneOf: (row: DemoOrder) => row.status,
            onMove: (row: DemoOrder, laneId: string) => {
              setData((current) => current.map((entry) => (entry.id === row.id ? { ...entry, status: laneId as DemoOrder['status'] } : entry)))
              return true
            },
            moveHeld: (row: DemoOrder, laneId: string) => (row.status === 'SHIPPED' ? shipped : laneId === 'READY' && row.status === 'CONFIRMED' ? t('tools.demo.held.ready') : null),
          },
          calendar: { dateOf: (row: DemoOrder) => row.promised, label: t('tools.demo.col.promised'), field: 'promised' },
        },
        cards: { hrefOf: (row: DemoOrder) => `#${row.id}` },
        edit,
        quick,
        today,
        ...(model.design ? { design: model.design } : {}),
        ...(model.price ? {} : { withheld: [{ label: t('tools.demo.col.net'), reason: t('tools.demo.withheldNet') }] }),
      }
    : {}

  return (
    <ListToolsContext.Provider value={transport}>
      <ListFrame<DemoOrder>
        label={t('tools.demo.title')}
        title={t('tools.demo.title')}
        rows={model.loading ? null : model.rows.length === 0 ? [] : shown}
        rowId={(row) => row.id}
        columns={columns}
        count={t('tools.demo.count', { count: shown.length })}
        search={<Input size="sm" type="search" leadingIcon={<Search size={13} aria-hidden />} aria-label={t('tools.demo.search')} placeholder={t('tools.demo.search')} value={q} onChange={(event) => set({ q: event.target.value })} />}
        tools={
          <Select size="sm" aria-label={t('tools.demo.rowsLabel')} value={rows} onChange={(event) => set({ rows: event.target.value as Rows })}>
            {ROWS.map((value) => (
              <option key={value} value={value}>
                {t(`tools.demo.rows.${value}`)}
              </option>
            ))}
          </Select>
        }
        selection={{ selected, onChange: setSelected, actions: null, exportSelected: !!model.w2b }}
        state={
          model.w2b && model.rows.length > 0 && shown.length === 0 ? (
            <EmptyState title={t('lab.noMatch')} action={<Button size="sm" onClick={() => setQuery(withMode('', mode))}>{t('lab.clearFilters')}</Button>} />
          ) : undefined
        }
        {...w2b}
      />
    </ListToolsContext.Provider>
  )
}
