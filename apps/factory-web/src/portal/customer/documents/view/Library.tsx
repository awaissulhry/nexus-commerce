'use client'

import { useMemo, useRef, type ReactNode } from 'react'
import { ClipboardList, Download, Eye, FileText, MoreHorizontal, Receipt, ShieldCheck, Truck, type LucideIcon } from 'lucide-react'
import { EmptyState, Menu, type MenuItemDef } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Pill, SegmentedControl, Toggle } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../list-frame/ListFrame'
import type { LibraryChip } from '../api'
import { bulkDownloadHeld, kindKey, type Grouping, type LibraryRow } from '../model'
import { languageWords } from '../preview/model'
import { useDocumentWords } from '../words'

/**
 * SCR-186 › All documents (design portal.customer.documents sec:library "Every issued document, fixed versions only"; SAL-086,
 * SAL-092, QHS-111) on the shared list frame (select-all, shift range, x / Space, "Download N" while rows are selected, the
 * keys only in the footer's icon, cards on a phone): type icon · title · what it is for (order, shipment, style) · date ·
 * version + fingerprint · language · NEW. Preview (the pop-up, Enter), Download (logged, `d` on the focused row), ⋯ each
 * file in a new tab (an invoice's PDF and XML); an earlier version says "Replaced by v4" and opens the newer one. Grouped
 * by order or by style on demand; earlier versions on demand. No amount here (To pay has them, for Finance).
 */

export interface LibraryModel {
  state: 'loading' | 'error' | 'ready'
  rows: readonly LibraryRow[] | null
  /** Rows matching on the server (for "N of M"). */
  total: number
  group: LibraryChip
  q: string
  by: Grouping
  versions: 'current' | 'all'
  selected: readonly string[]
  /** The row whose open runs. */
  busy: string | null
  /** Why nothing may be opened now (a preview, offline), a key. */
  held: string | null
  /** Live: documents issued since the list was read. */
  updates: number
  /** More rows on the server. */
  more: boolean
  loadingMore: boolean
  prefix: string
  keysOpen?: boolean
  focusRow?: number
}

export interface LibraryActions {
  onSearch?: (q: string) => void
  onBy?: (by: Grouping) => void
  onVersions?: (versions: 'current' | 'all') => void
  onSelect?: (ids: string[]) => void
  onPreview?: (row: LibraryRow) => void
  onDownload?: (row: LibraryRow) => void
  onDownloadMany?: (ids: readonly string[]) => void
  onTab?: (row: LibraryRow, fileId: string) => void
  onReplaced?: (row: LibraryRow) => void
  onRetry?: () => void
  onShowUpdates?: () => void
  onMore?: () => void
  onHelp?: () => void
  onClearSearch?: () => void
  onAll?: () => void
}

const GROUP_ICON: Readonly<Record<string, LucideIcon>> = { DELIVERY: Truck, CONFORMITY: ShieldCheck, FINANCE: Receipt, ORDERS: ClipboardList, OTHER: FileText }
export const kindIcon = (group: string): LucideIcon => GROUP_ICON[group] ?? FileText

export function LibrarySection({ model, actions }: { model: LibraryModel; actions?: LibraryActions }) {
  const { t, day } = useDocumentWords()
  const latest = useRef({ model, actions })
  latest.current = { model, actions }

  const columns = useMemo((): ColDef<LibraryRow>[] => {
    const heldWords = () => {
      const now = latest.current.model
      return now.held ? t(now.held) : null
    }
    const DocumentCell = ({ data }: ICellRendererParams<LibraryRow>) => {
      if (!data) return null
      const Icon = kindIcon(data.group)
      return (
        <span className="fw-pdoc-doc">
          <Icon size={16} aria-hidden className="fw-pdoc-icon" />
          <span className="fw-pdoc-two">
            <span className="fw-pdoc-title fw-pdoc-ellipsis" title={data.title}>
              {data.title}
            </span>
            <span className="fw-pdoc-sub fw-pdoc-line">
              {data.isNew ? <Pill tone="info">{t('row.new')}</Pill> : null}
              {/* An earlier version names the newer one first (it must never be cut off). */}
              {!data.current && data.replacedBy ? (
                <button type="button" className="fw-pdoc-linkbtn fw-pdoc-nowrap" onClick={() => latest.current.actions?.onReplaced?.(data)}>
                  {t('row.replacedBy', { version: data.replacedBy.version })}
                </button>
              ) : null}
              <span className="fw-pdoc-ellipsis">{t(kindKey(data.kind))}</span>
            </span>
          </span>
        </span>
      )
    }
    // Two lines: the order (their PO first) and the record it is of — a shipment, an invoice — or else the style. Grouped
    // by style, the style leads (the rows of one style sit together).
    const ForCell = ({ data }: ICellRendererParams<LibraryRow>) => {
      if (!data) return null
      const now = latest.current.model
      const record = data.forLabel || forKind(data.forType) === 'account' ? t(`for.${forKind(data.forType)}`, { label: data.forLabel ?? '' }) : null
      const style = data.style ? t('row.style', { code: data.style.code, name: data.style.name }) : null
      const order = data.order ? (
        <a className="fw-pdoc-ellipsis" href={`${now.prefix}/open/SalesOrder/${encodeURIComponent(data.order.id)}`} title={t('row.order', { number: data.order.words })}>
          {data.order.words}
        </a>
      ) : null
      const sub = (text: string | null) =>
        text ? (
          <span className="fw-pdoc-sub fw-pdoc-ellipsis" title={text}>
            {text}
          </span>
        ) : null
      if (now.by === 'style')
        return (
          <span className="fw-pdoc-two">
            <span className="fw-pdoc-ellipsis" title={style ?? undefined}>
              {style ?? t('groupBy.noStyle')}
            </span>
            {order ?? sub(record)}
          </span>
        )
      return (
        <span className="fw-pdoc-two">
          {order ?? <span className="fw-pdoc-ellipsis">{record ?? style ?? (now.by === 'order' ? t('groupBy.noOrder') : '—')}</span>}
          {order ? sub(record ?? style) : record ? sub(style) : null}
        </span>
      )
    }
    const VersionCell = ({ data }: ICellRendererParams<LibraryRow>) =>
      data ? (
        <span className="fw-pdoc-two">
          <span className="fw-pdoc-mono" title={t('row.fingerprintHint')}>
            {t('row.version', { version: data.version, fingerprint: data.fingerprint })}
          </span>
          {data.expiresOn ? <span className="fw-pdoc-sub">{t('row.validUntil', { date: day(data.expiresOn) })}</span> : null}
        </span>
      ) : null
    const ActionsCell = ({ data }: ICellRendererParams<LibraryRow>) => {
      if (!data) return null
      const now = latest.current.model
      const held = heldWords() ?? (now.busy === data.id ? t('row.opening') : null)
      const tabs: MenuItemDef[] = data.files.map((file) => ({
        id: `tab:${file.fileId}`,
        label: t(`row.tab.${file.format}`),
        disabled: held !== null,
        description: held ?? undefined,
        onSelect: () => latest.current.actions?.onTab?.(data, file.fileId),
      }))
      const items: MenuItemDef[] = [
        ...tabs,
        ...(data.order ? [{ id: 'order', label: t('row.openOrder', { number: data.order.words }), href: `${now.prefix}/open/SalesOrder/${encodeURIComponent(data.order.id)}` }] : []),
      ]
      return (
        <span className="fw-pdoc-actions">
          {data.previewable ? (
            <Button size="sm" heldReason={held} aria-haspopup="dialog" aria-label={t('row.previewOf', { title: data.title })} onClick={() => latest.current.actions?.onPreview?.(data)}>
              <Eye size={14} aria-hidden /> <span className="fw-pdoc-btnword">{t('row.preview')}</span>
            </Button>
          ) : null}
          <Button size="sm" heldReason={held} aria-label={t('row.downloadOf', { title: data.title })} onClick={() => latest.current.actions?.onDownload?.(data)}>
            <Download size={14} aria-hidden /> <span className="fw-pdoc-btnword">{t('row.download')}</span>
          </Button>
          {items.length > 0 ? <Menu align="right" label={<MoreHorizontal size={16} aria-hidden />} triggerProps={{ 'aria-label': t('row.menu', { title: data.title }) }} items={items} /> : null}
        </span>
      )
    }
    const column = (colId: string, header: string, cellRenderer: ColDef<LibraryRow>['cellRenderer'], size: { flex?: number; minWidth?: number; width?: number; maxWidth?: number }): ColDef<LibraryRow> => ({ colId, headerName: header, cellRenderer, sortable: false, ...size })
    return [
      // The phone card's title is the column's text: the document's title.
      { ...column('document', t('col.document'), DocumentCell, { flex: 1.5, minWidth: 230 }), valueGetter: ({ data }) => data?.title ?? '' },
      { ...column('for', t('col.for'), ForCell, { flex: 1, minWidth: 190 }), valueGetter: ({ data }) => (data ? [data.order ? t('row.order', { number: data.order.words }) : null, data.forLabel, data.style?.code].filter(Boolean).join(' · ') : '') },
      { ...column('date', t('col.date'), undefined, { flex: 0.5, minWidth: 104 }), valueGetter: ({ data }) => (data ? day(data.date) : '') },
      { ...column('version', t('col.version'), VersionCell, { flex: 0.8, minWidth: 150 }), valueGetter: ({ data }) => (data ? t('row.version', { version: data.version, fingerprint: data.fingerprint }) : '') },
      { ...column('language', t('col.language'), undefined, { flex: 0.4, minWidth: 112 }), valueGetter: ({ data }) => (data?.language ? languageWords(t, data.language) : '—') },
      { ...column('actions', t('col.actions'), ActionsCell, { width: 292, minWidth: 292, maxWidth: 292 }), pinned: 'right', suppressHeaderMenuButton: true },
    ]
  }, [t, day])

  const selected = model.selected
  const count = selected.length
  const bulkHeld = bulkDownloadHeld(count, model.held)
  const bulk = (
    <Button size="sm" heldReason={bulkHeld ? t(bulkHeld.key, bulkHeld.params) : null} onClick={() => actions?.onDownloadMany?.(selected)} aria-label={t('bulk.download', { count })}>
      <Download size={13} aria-hidden /> <SelectionLabel>{t('bulk.download', { count })}</SelectionLabel>
    </Button>
  )
  const searching = model.q.trim() !== ''
  const rows = model.rows
  const state: ReactNode =
    model.state === 'error' ? (
      <EmptyState title={t('library.failed')} description={t('library.failedBody')} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('state.retry')}</Button>} />
    ) : rows !== null && rows.length === 0 ? (
      searching ? (
        <EmptyState title={t('library.none')} description={t('library.noMatch', { q: model.q.trim() })} action={<Button size="sm" onClick={() => actions?.onClearSearch?.()}>{t('library.clear')}</Button>} />
      ) : model.group !== 'ALL' ? (
        <EmptyState title={t('library.none')} description={t('library.noneIn', { group: t(`group.${model.group}`) })} action={<Button size="sm" onClick={() => actions?.onAll?.()}>{t('library.showAll')}</Button>} />
      ) : (
        <EmptyState icon={<FileText size={24} aria-hidden />} title={t('library.empty')} description={t('library.emptyBody')} />
      )
    ) : undefined

  return (
    <section className="fw-pdoc-section fw-pdoc-library" aria-labelledby="fw-pdoc-library">
      <div className="fw-pdoc-head">
        <div className="fw-pdoc-headtext">
          <h2 id="fw-pdoc-library" className="fw-pdoc-h2">
            {t('library.title')}
          </h2>
          <p className="fw-pdoc-sub">{t('library.hint')}</p>
        </div>
      </div>
      <ListFrame<LibraryRow>
        label={t('library.label')}
        title={t('library.title')}
        listKey={null}
        rows={model.state === 'error' ? [] : rows}
        rowId={(row) => row.id}
        columns={columns}
        count={rows && model.state !== 'error' ? (model.total > rows.length ? t('library.countOf', { count: rows.length, total: model.total }) : t('library.count', { count: rows.length })) : ''}
        search={
          <Input
            type="search"
            aria-label={t('library.search')}
            placeholder={t('library.searchHint')}
            defaultValue={model.q}
            maxLength={80}
            onKeyDown={(event) => {
              if (event.key === 'Enter') actions?.onSearch?.((event.target as HTMLInputElement).value)
              if (event.key === 'Escape' && (event.target as HTMLInputElement).value === '') (event.target as HTMLInputElement).blur()
            }}
            onBlur={(event) => {
              if (event.target.value.trim() !== model.q.trim()) actions?.onSearch?.(event.target.value)
            }}
          />
        }
        tools={
          <span className="fw-pdoc-tools">
            <SegmentedControl
              size="sm"
              ariaLabel={t('groupBy.label')}
              value={model.by}
              onChange={(value) => actions?.onBy?.(value as Grouping)}
              options={[
                { value: 'newest', label: t('groupBy.newest') },
                { value: 'order', label: t('groupBy.byOrder') },
                { value: 'style', label: t('groupBy.byStyle') },
              ]}
            />
            <label className="fw-pdoc-toggle">
              <Toggle size="sm" checked={model.versions === 'all'} onChange={(next) => actions?.onVersions?.(next ? 'all' : 'current')} aria-label={t('library.earlier')} />
              <span>{t('library.earlier')}</span>
            </label>
          </span>
        }
        selection={{ selected, onChange: (ids) => actions?.onSelect?.(ids), actions: bulk }}
        updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
        more={model.more ? { label: t('library.more'), onMore: () => actions?.onMore?.(), held: model.loadingMore ? t('state.loading') : null } : null}
        keys={[{ keys: ['d'], does: t('keys.download') }]}
        onHelp={actions?.onHelp}
        onOpen={(row) => (row.previewable ? actions?.onPreview?.(row) : actions?.onDownload?.(row))}
        state={state}
        cards={{}}
        keysOpen={model.keysOpen}
        focusRow={model.focusRow}
      />
    </section>
  )
}

/** The record a document is of, as the "For" column words it (`for.<kind>`). */
export function forKind(type: string | null): 'shipment' | 'invoice' | 'quote' | 'style' | 'account' | 'record' {
  switch (type) {
    case 'Shipment':
      return 'shipment'
    case 'Invoice':
      return 'invoice'
    case 'Quote':
    case 'QuoteVersion':
      return 'quote'
    case 'Style':
      return 'style'
    case 'Party':
    case 'Company':
      return 'account'
    default:
      return 'record'
  }
}
