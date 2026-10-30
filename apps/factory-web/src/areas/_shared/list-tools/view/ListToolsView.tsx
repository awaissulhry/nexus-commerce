'use client'

import { useMemo, useRef, useState } from 'react'
import { MoreHorizontal, Search } from 'lucide-react'
import { Menu } from '@nexus/ui/components'
import type { ColDef, ICellRendererParams } from '@nexus/ui/grid'
import { Input, Pill, Select } from '@nexus/ui/primitives'
import { formatDate } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { ListToolsContext } from '../../../../list-frame/tools/transport'
import { memoryStore, memoryTransport, type MemoryToolsModel } from '../memory'

/**
 * SCR-232 — List tools (design shell.lists; PLT-163, PLT-179): the toolbar's Columns ▾ (saved views: mine, shared with a
 * role or everyone, a role's default; Save view as…, Update, Rename or share, Copy link, Remove; Customise columns…) and
 * Export ▾ (this view as CSV or Excel, then my recent exports with the export-job dialog), in the ONE list frame every
 * Office list uses — here over a made-up list of sales orders and the tools in memory, so every menu and dialog works
 * in the browser. The list's own filters (Rows ▾, the search) are its address terms: a view keeps them.
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
}

export interface ListToolsModel {
  readonly tools: MemoryToolsModel
  readonly rows: readonly DemoOrder[]
  /** The page's address terms when it opens (`late=true&q=demo`). */
  readonly query: string
  /** The reader holds the price grain (the Net column is there). */
  readonly price: boolean
}

const ROWS = ['open', 'late', 'all'] as const
type Rows = (typeof ROWS)[number]
const TONE = { CONFIRMED: 'info', IN_PRODUCTION: 'warning', READY: 'success', SHIPPED: 'neutral' } as const

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
  const terms = new URLSearchParams(query)
  const rows: Rows = terms.get('late') === 'true' ? 'late' : terms.get('rows') === 'all' ? 'all' : 'open'
  const q = terms.get('q') ?? ''
  const set = (next: { rows?: Rows; q?: string }) => {
    const params = new URLSearchParams()
    const r = next.rows ?? rows
    if (r === 'late') params.set('late', 'true')
    if (r === 'all') params.set('rows', 'all')
    const text = (next.q ?? q).trim()
    if (text) params.set('q', text)
    setQuery(params.toString())
  }
  const shown = model.rows.filter((row) => (rows === 'late' ? row.late : rows === 'open' ? row.status !== 'SHIPPED' : true) && (q === '' || `${row.number} ${row.customer}`.toLowerCase().includes(q.toLowerCase())))
  const [selected, setSelected] = useState<string[]>([])

  const columns = useMemo<ColDef<DemoOrder>[]>(() => {
    const money = new Intl.NumberFormat(locale === 'en' ? 'en-GB' : 'it-IT', { style: 'currency', currency: 'EUR' })
    const MoreCell = ({ data }: ICellRendererParams<DemoOrder>) =>
      data ? <Menu label={<MoreHorizontal size={16} aria-hidden />} align="right" triggerProps={{ 'aria-label': t('tools.demo.rowMenu', { number: data.number }) }} items={[{ id: 'open', label: t('tools.demo.open'), href: `#${data.id}` }]} /> : null
    return [
      { colId: 'number', headerName: t('tools.demo.col.number'), field: 'number', minWidth: 130, flex: 1, cellRenderer: ({ data }: ICellRendererParams<DemoOrder>) => (data ? <a href={`#${data.id}`}>{data.number}</a> : null) },
      { colId: 'customer', headerName: t('tools.demo.col.customer'), field: 'customer', minWidth: 170, flex: 1.5 },
      { colId: 'status', headerName: t('tools.demo.col.status'), field: 'status', minWidth: 130, flex: 0.9, cellRenderer: ({ data }: ICellRendererParams<DemoOrder>) => (data ? <Pill tone={TONE[data.status]}>{t(`tools.demo.status.${data.status}`)}</Pill> : null) },
      { colId: 'promised', headerName: t('tools.demo.col.promised'), field: 'promised', minWidth: 130, flex: 0.9, valueFormatter: ({ value }: { value: string }) => formatDate(`${value}T12:00:00Z`, { locale }) },
      ...(model.price ? [{ colId: 'net', headerName: t('tools.demo.col.net'), field: 'net' as const, minWidth: 110, flex: 0.8, type: 'rightAligned', valueFormatter: ({ value }: { value: number }) => money.format(value / 100) }] : []),
      { colId: 'more', headerName: t('tools.demo.col.more'), minWidth: 64, maxWidth: 64, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
  }, [t, locale, model.price])

  return (
    <ListToolsContext.Provider value={transport}>
      <ListFrame<DemoOrder>
        label={t('tools.demo.title')}
        title={t('tools.demo.title')}
        rows={model.rows.length === 0 ? [] : shown}
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
        selection={{ selected, onChange: setSelected, actions: null }}
      />
    </ListToolsContext.Provider>
  )
}
