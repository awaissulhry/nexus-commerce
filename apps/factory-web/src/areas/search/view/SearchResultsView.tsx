'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { Copy, MoreHorizontal, Search } from 'lucide-react'
import { matchedParts } from '@nexus/factory-domain/search/highlight'
import type { SearchMatch } from '@nexus/factory-domain/search/contracts'
import { Banner, EmptyState, Menu } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { PageHeader } from '@nexus/ui/patterns'
import { Button, FilterChip, Input, Pill } from '@nexus/ui/primitives'
import { ListFrame } from '../../../list-frame/ListFrame'
import { formatTime } from '../../../lib/i18n/format'
import { useLocale, useScopedT, useT } from '../../../lib/i18n/provider'
import { WithMessages } from '../../../record-panels/i18n'
import { areaKey, chipKey, statusKey, statusTone, typeKey, whyKey } from '../model'
import { RecordTypeIcon } from '../RecordTypeIcon'
import '../search.css'

/**
 * SCR-248 (NEW id, B-W2a-32) — All results (design shell.search/sec:results; PLT-153): the full results of a search
 * when the palette is not enough, grouped by type. The search field (the address's `?q=`), the type chips with their
 * counts (Orders 4 · Customers 2 · Lots 7 …; `?type=` one of them), and the results on the shared list frame: the type
 * with its icon, the number (a link: ⌘-click a new tab), the name and the line under it with the words that matched
 * marked, the area, the status, the company, and why it matched (its number, every word, or a similar word: a typo
 * forgiven). Select rows (header box, shift range, x) to copy their numbers. Enter opens. The records are only those
 * the person may open; nothing here shows money. The index's time says how current it is.
 */

export interface SearchResultRow {
  recordType: string
  recordId: string
  number: string | null
  title: string
  subtitle: string | null
  status: string | null
  area: string
  companyCode: string | null
  match: SearchMatch
  /** Where it opens (full address). */
  href: string
}

export interface SearchResultsViewModel {
  q: string
  type: string | null
  /** start: nothing to search yet · loading · slow · error · ready · noAccess: the person's roles open no record type */
  state: 'start' | 'loading' | 'slow' | 'error' | 'ready' | 'noAccess'
  /** The query's words as the search read them (marked in the rows). */
  words: readonly string[]
  rows: readonly SearchResultRow[]
  counts: readonly { recordType: string; count: number }[]
  total: number
  more: boolean
  loadingMore?: boolean
  asOf: string | null
  timeZone?: string
  notice?: { tone: 'success' | 'danger'; key: string; count?: number } | null
  /** Design cases: rows selected, the keys panel open. */
  selected?: readonly string[]
  keysOpen?: boolean
}

export interface SearchResultsViewActions {
  onSearch?: (q: string) => void
  onType?: (type: string | null) => void
  onMore?: () => void
  onRetry?: () => void
  onOpen?: (row: SearchResultRow) => void
  onCopy?: (numbers: string[]) => void
  onDismissNotice?: () => void
}

export function SearchResultsView({ model, actions }: { model: SearchResultsViewModel; actions?: SearchResultsViewActions }) {
  return (
    <WithMessages namespaces={['search', 'lists']}>
      <Results model={model} actions={actions} />
    </WithMessages>
  )
}

function Marked({ text, words }: { text: string; words: readonly string[] }) {
  return (
    <>
      {matchedParts(text, words).map((part, index) =>
        part.hit ? (
          <mark key={index} className="fw-search-hit">
            {part.text}
          </mark>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  )
}

function Results({ model, actions }: { model: SearchResultsViewModel; actions?: SearchResultsViewActions }) {
  const t = useT('search')
  const scoped = useScopedT('search')
  const locale = useLocale()
  const [query, setQuery] = useState(model.q)
  useEffect(() => setQuery(model.q), [model.q])
  const typed = useRef(false)
  const latest = useRef(actions)
  latest.current = actions
  useEffect(() => {
    if (!typed.current) return
    const timer = setTimeout(() => latest.current?.onSearch?.(query), 300)
    return () => clearTimeout(timer)
  }, [query])
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  const rowsKey = model.rows.map((row) => row.recordId).join(',')
  useEffect(() => setSelected((current) => current.filter((id) => rowsKey.includes(id))), [rowsKey])

  const columns = useMemo<ColDef<SearchResultRow>[]>(() => {
    const TypeCell = ({ data }: ICellRendererParams<SearchResultRow>) =>
      data ? (
        <span className="fw-search-type">
          <RecordTypeIcon type={data.recordType} size={15} />
          <span>{t(typeKey(data.recordType))}</span>
        </span>
      ) : null
    const NumberCell = ({ data }: ICellRendererParams<SearchResultRow>) =>
      data ? (
        <Link className="fw-search-link fw-search-number" href={data.href}>
          {data.number ? <Marked text={data.number} words={model.words} /> : t('page.open')}
        </Link>
      ) : null
    const NameCell = ({ data }: ICellRendererParams<SearchResultRow>) =>
      data ? (
        <span className="fw-search-cell" title={[data.title, data.subtitle].filter(Boolean).join(' · ')}>
          <span className="fw-search-ellipsis">
            <Marked text={data.title} words={model.words} />
          </span>
          {data.subtitle && (
            <span className="fw-search-sub">
              <Marked text={data.subtitle} words={model.words} />
            </span>
          )}
        </span>
      ) : null
    const AreaCell = ({ data }: ICellRendererParams<SearchResultRow>) => {
      const key = data ? areaKey(data.area) : null
      return <span>{key ? scoped(key) : '—'}</span>
    }
    const StatusCell = ({ data }: ICellRendererParams<SearchResultRow>) => {
      const key = data ? statusKey(data.status) : null
      return key && data ? <Pill tone={statusTone(data.status)}>{t(key)}</Pill> : <span>—</span>
    }
    const CompanyCell = ({ data }: ICellRendererParams<SearchResultRow>) => <span className="fw-search-mono">{data?.companyCode ?? '—'}</span>
    const WhyCell = ({ data }: ICellRendererParams<SearchResultRow>) => (data ? <span className={data.match === 'similar' ? 'fw-search-why similar' : 'fw-search-why'}>{t(whyKey(data.match))}</span> : null)
    const MoreCell = ({ data }: ICellRendererParams<SearchResultRow>) =>
      data ? (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('page.rowMenu', { name: data.number ?? data.title }) }}
          items={[
            { id: 'open', label: t('page.open'), href: data.href },
            { id: 'tab', label: t('page.openNewTab'), href: data.href, target: '_blank' },
          ]}
        />
      ) : null
    return [
      { colId: 'type', headerName: t('col.type'), minWidth: 200, flex: 1, cellRenderer: TypeCell },
      { colId: 'number', headerName: t('col.number'), minWidth: 160, flex: 0.9, cellRenderer: NumberCell },
      { colId: 'name', headerName: t('col.name'), minWidth: 240, flex: 2, cellRenderer: NameCell },
      { colId: 'area', headerName: t('col.area'), minWidth: 120, flex: 0.6, cellRenderer: AreaCell },
      { colId: 'status', headerName: t('col.status'), minWidth: 150, flex: 0.8, cellRenderer: StatusCell },
      { colId: 'company', headerName: t('col.company'), minWidth: 110, flex: 0.5, cellRenderer: CompanyCell },
      { colId: 'why', headerName: t('col.why'), minWidth: 170, flex: 0.9, cellRenderer: WhyCell },
      { colId: 'more', headerName: t('col.actions'), minWidth: 84, maxWidth: 84, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
  }, [t, scoped, model.words])

  const search = (
    <Input
      size="sm"
      type="search"
      leadingIcon={<Search size={13} aria-hidden />}
      aria-label={t('page.searchLabel')}
      placeholder={t('page.placeholder')}
      value={query}
      autoFocus={model.q === ''}
      onChange={(event) => {
        typed.current = true
        setQuery(event.target.value)
      }}
    />
  )

  const all = model.counts.reduce((sum, entry) => sum + entry.count, 0)
  const chips =
    model.state === 'ready' && model.counts.length > 0 ? (
      <div className="fw-search-chips" role="group" aria-label={t('page.chipsLabel')}>
        <FilterChip pressed={model.type === null} count={all} onClick={() => actions?.onType?.(null)}>
          {t('page.allTypes')}
        </FilterChip>
        {model.counts.map((entry) => (
          <FilterChip key={entry.recordType} pressed={model.type === entry.recordType} count={entry.count} onClick={() => actions?.onType?.(model.type === entry.recordType ? null : entry.recordType)}>
            {t(chipKey(entry.recordType))}
          </FilterChip>
        ))}
      </div>
    ) : null

  const picked = model.rows.filter((row) => selected.includes(row.recordId))
  const numbers = picked.filter((row) => row.number).map((row) => row.number!)
  const retry = (
    <Button size="sm" onClick={() => actions?.onRetry?.()}>
      {t('state.retry')}
    </Button>
  )
  const state =
    model.state === 'start' ? (
      <EmptyState title={t('state.startTitle')} description={t('state.start')} />
    ) : model.state === 'noAccess' ? (
      <EmptyState title={t('state.noAccessTitle')} description={t('state.noAccess')} />
    ) : model.state === 'error' ? (
      <EmptyState title={t('state.errorTitle')} description={t('state.error')} action={retry} />
    ) : model.state === 'ready' && model.rows.length === 0 ? (
      <EmptyState title={t('state.emptyTitle')} description={t('state.empty')} />
    ) : undefined
  const loading = model.state === 'loading' || model.state === 'slow'
  const place = { locale, timeZone: model.timeZone }

  return (
    <div className="fw-search">
      <PageHeader
        title={t('page.title')}
        subtitle={t('page.subtitle')}
        actions={
          <span className="fw-search-status" role="status">
            {model.state === 'slow' ? t('state.slow') : model.asOf ? t('page.asOf', { time: formatTime(model.asOf, place) }) : t('page.asOfEmpty')}
          </span>
        }
      />
      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={t(model.notice.key, model.notice.count === undefined ? undefined : { count: model.notice.count })}
          action={
            actions?.onDismissNotice ? (
              <Button size="sm" variant="quiet" onClick={actions.onDismissNotice}>
                {t('page.dismiss')}
              </Button>
            ) : undefined
          }
        />
      )}
      {chips}
      <ListFrame<SearchResultRow>
        label={t('page.tableLabel')}
        rows={loading ? null : state ? [] : model.rows}
        rowId={(row) => row.recordId}
        columns={columns}
        count={model.state === 'ready' ? (model.more ? t('page.countOf', { shown: model.rows.length, total: model.total }) : t('page.count', { count: model.total })) : '—'}
        search={search}
        selection={{
          selected,
          onChange: setSelected,
          actions: (
            <Button size="sm" aria-label={t('page.copy', { count: numbers.length })} heldReason={numbers.length === 0 ? t('page.noNumber') : null} onClick={() => actions?.onCopy?.(numbers)}>
              <Copy size={13} aria-hidden /> <SelectionLabel>{t('page.copy', { count: numbers.length })}</SelectionLabel>
            </Button>
          ),
        }}
        isRowSelectable={(row) => (row.number ? null : t('page.noNumber'))}
        more={model.more && model.rows.length > 0 ? { label: t('page.showMore'), onMore: () => actions?.onMore?.(), held: model.loadingMore ? t('state.loading') : null } : null}
        onOpen={(row) => actions?.onOpen?.(row)}
        state={state}
        keysOpen={model.keysOpen}
      />
      <p className="fw-search-hint">{t('page.tips')}</p>
    </div>
  )
}
