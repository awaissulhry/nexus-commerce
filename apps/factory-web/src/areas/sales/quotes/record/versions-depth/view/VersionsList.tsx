'use client'

import { useMemo, useRef } from 'react'
import { ArrowLeftRight, Download } from 'lucide-react'
import { Banner, EmptyState } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Pill } from '@nexus/ui/primitives'
import { formatDate, formatDateTime } from '../../../../../../lib/i18n/format'
import { useLocale } from '../../../../../../lib/i18n/provider'
import { ListFrame } from '../../../../../../list-frame/ListFrame'
import type { ListKey } from '../../../../../../list-frame/model'
import type { QuoteVersionRow } from '../../../api'
import { money, STATUS_TONE, type Grains } from '../../../model'
import { useDepthWords } from '../../lines-depth/words'
import { latestPair, pairOf } from '../model'

export interface VersionsListModel {
  items: QuoteVersionRow[] | null
  people: Readonly<Record<string, string>>
  me: string
  grains: Grains
  /** W1's `sales` problem key of a failed read, or null. */
  problem: string | null
  selected: readonly string[]
}

export interface VersionsListActions {
  onSelect?: (ids: string[]) => void
  onCompare?: (pair: { from: number; to: number }) => void
  onDownload?: (fileId: string) => void
  onRetry?: () => void
}

/**
 * Versions in the ONE list frame (design quote.versions.list, W1's columns: version, status, made, sent, net / gross with
 * the price grain, what changed, the decision, the PDF) with real multi-select: two rows selected → Compare (W2b,
 * SAL-158), and "Compare with the one before" for the current version. It replaces W1's table on the tab (the slot).
 */
export function VersionsList({ model, actions }: { model: VersionsListModel; actions?: VersionsListActions }) {
  const { t, sales } = useDepthWords()
  const locale = useLocale()
  const latest = useRef(actions)
  latest.current = actions
  const who = (id: string | null) => (id === null ? '—' : id === model.me ? sales('common.you') : (model.people[id] ?? sales('common.colleague')))

  const columns = useMemo<ColDef<QuoteVersionRow>[]>(() => {
    const StatusCell = ({ data }: ICellRendererParams<QuoteVersionRow>) => (data ? <Pill tone={STATUS_TONE[data.status]}>{sales(`status.${data.status}`)}</Pill> : null)
    const PdfCell = ({ data }: ICellRendererParams<QuoteVersionRow>) =>
      data?.document ? (
        <Button size="sm" variant="quiet" onClick={() => latest.current?.onDownload?.(data.document!.fileId)} aria-label={t('versions.downloadOf', { revision: data.revision })}>
          <Download size={14} aria-hidden /> {sales('versions.download')}
        </Button>
      ) : null
    const decision = (version: QuoteVersionRow) =>
      version.acceptance
        ? sales('versions.acceptedBy', { name: version.acceptance.signerName, at: formatDateTime(version.acceptance.acceptedAt, { locale }) })
        : version.status === 'DECLINED'
          ? sales('versions.declined', { note: version.decisionNote ?? '—' })
          : version.status === 'SUPERSEDED'
            ? sales('versions.superseded')
            : version.validUntil && version.status === 'SENT'
              ? sales('versions.openUntil', { date: formatDate(`${version.validUntil}T12:00:00Z`, { locale }) })
              : '—'
    return [
      { colId: 'version', headerName: sales('versions.col.version'), minWidth: 120, valueGetter: (params) => (params.data ? sales('record.versionChip', { revision: params.data.revision }) : '') },
      { colId: 'status', headerName: sales('versions.col.status'), minWidth: 130, cellRenderer: StatusCell, valueGetter: (params) => params.data?.status ?? '' },
      { colId: 'made', headerName: sales('versions.col.made'), minWidth: 200, flex: 1, valueGetter: (params) => (params.data ? sales('versions.byAt', { who: who(params.data.createdById), at: formatDateTime(params.data.createdAt, { locale }) }) : '') },
      { colId: 'sent', headerName: sales('versions.col.sent'), minWidth: 200, flex: 1, valueGetter: (params) => (params.data?.sentAt ? sales('versions.byAt', { who: who(params.data.sentById), at: formatDateTime(params.data.sentAt, { locale }) }) : '—') },
      ...(model.grains.price ? ([{ colId: 'total', headerName: sales('versions.col.total'), minWidth: 190, type: 'rightAligned', valueGetter: (params) => (params.data ? `${money(params.data.netAmount, params.data.currency, locale)} / ${money(params.data.grossAmount, params.data.currency, locale)}` : '') }] satisfies ColDef<QuoteVersionRow>[]) : []),
      { colId: 'changed', headerName: sales('versions.col.changed'), minWidth: 200, flex: 1.4, wrapText: true, autoHeight: true, valueGetter: (params) => params.data?.changeNote ?? '—' },
      { colId: 'decision', headerName: sales('versions.col.decision'), minWidth: 200, flex: 1.2, wrapText: true, autoHeight: true, valueGetter: (params) => (params.data ? decision(params.data) : '') },
      { colId: 'pdf', headerName: sales('versions.col.pdf'), minWidth: 120, sortable: false, cellRenderer: PdfCell },
    ]
    // who() reads the people and the person through the closure.
  }, [t, sales, locale, model.grains.price, model.people, model.me])

  if (model.problem)
    return (
      <Banner
        tone="danger"
        title={sales(model.problem)}
        action={
          <Button size="sm" onClick={() => actions?.onRetry?.()}>
            {sales('common.retry')}
          </Button>
        }
      />
    )
  const items = model.items
  const pair = items ? pairOf(items, model.selected) : null
  const before = items ? latestPair(items) : null
  const keys: ListKey[] = []
  return (
    <ListFrame<QuoteVersionRow>
      label={sales('versions.tableLabel')}
      title={sales('versions.tableLabel')}
      listKey={null}
      rows={items}
      rowId={(row) => row.id}
      columns={columns}
      count={items ? t('versions.count', { count: items.length }) : t('common.loading')}
      right={
        before ? (
          <Button size="sm" onClick={() => actions?.onCompare?.(before)}>
            <ArrowLeftRight size={14} aria-hidden /> {t('versions.compareLatest', { from: before.from, to: before.to })}
          </Button>
        ) : undefined
      }
      selection={{
        selected: model.selected,
        onChange: (ids) => actions?.onSelect?.(ids),
        actions: (
          <Button size="sm" variant="primary" heldReason={pair ? null : t('versions.pickTwo')} onClick={() => pair && actions?.onCompare?.(pair)} aria-label={pair ? t('versions.compareThese', { from: pair.from, to: pair.to }) : t('versions.compare')}>
            <ArrowLeftRight size={13} aria-hidden /> <SelectionLabel>{pair ? t('versions.compareThese', { from: pair.from, to: pair.to }) : t('versions.compare')}</SelectionLabel>
          </Button>
        ),
      }}
      keys={keys}
      state={items && items.length === 0 ? <EmptyState title={sales('versions.empty')} /> : undefined}
    />
  )
}
