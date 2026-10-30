'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { FolderDown, MoreHorizontal, Plus } from 'lucide-react'
import { EmptyState, Menu, Modal } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Pill, Select } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { listKeys, type ListKey } from '../../../../list-frame/model'
import { formatDateTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { EXPORT_STATUSES, type ExportRow, type ExportStatus } from '../api'
import { cancelHeld, filesHref, monthWords, reExportHeld, rowSelectable, wizardHref } from '../model'
import type { AccountingActions, AccountingModel } from '../view-model'

const STATUS_TONE: Readonly<Record<ExportStatus, 'neutral' | 'success' | 'warning'>> = { DRAFT: 'warning', EXPORTED: 'success', CANCELLED: 'neutral' }

/**
 * Exports (design finance.accounting sec:history): every batch, numbered — its period, what it carried (new, changed and
 * removed documents per package), who made it and when, its files (opened in a new tab to download), and on the
 * period's latest batch the documents changed since (a re-export carries only those: never a duplicate). Rows with files
 * can be chosen: "Files of N batches" opens them together. The list frame: `/` search is not offered (the filters are
 * the status and the year), j/k, x, Enter opens a batch's files. No money here.
 */
export function HistoryList({ model, actions }: { model: AccountingModel; actions?: AccountingActions }) {
  const t = useT('finance-accounting')
  const lists = useT('lists')
  const locale = useLocale()
  const [selectedOwn, setSelected] = useState<string[]>([])
  const [help, setHelp] = useState(false)
  const selected = model.selected ? [...model.selected] : selectedOwn
  const rows = model.history.rows

  const columns = useMemo<ColDef<ExportRow>[]>(() => {
    const BatchCell = ({ data }: ICellRendererParams<ExportRow>) =>
      data ? (
        <span className="fw-fac-cell">
          {data.files.length > 0 ? (
            <Link className="fw-fac-link" href={filesHref(model.prefix, [data.id])} target="_blank" rel="noopener noreferrer">
              {data.number ?? t('history.noNumber')}
            </Link>
          ) : (
            <span>{data.number ?? t('history.noNumber')}</span>
          )}
          <span className="fw-fac-cell-sub">
            <Pill tone={STATUS_TONE[data.status]}>{t(`status.${data.status}`)}</Pill>
          </span>
        </span>
      ) : null
    const PeriodCell = ({ data }: ICellRendererParams<ExportRow>) =>
      data ? (
        <span className="fw-fac-cell">
          <span>{monthWords(data.period.month, locale)}</span>
          <span className="fw-fac-cell-sub">
            {data.supersedes ? t('history.reExportOf', { number: data.supersedes.number ?? '—' }) : data.status === 'CANCELLED' ? t('history.cancelled') : t('history.firstExport')}
          </span>
        </span>
      ) : null
    const ContentsCell = ({ data }: ICellRendererParams<ExportRow>) => {
      if (!data) return null
      const total = data.contents.reduce((sum, entry) => sum + entry.new + entry.changed + entry.removed, 0)
      const changed = data.contents.reduce((sum, entry) => sum + entry.changed, 0)
      const removed = data.contents.reduce((sum, entry) => sum + entry.removed, 0)
      return (
        <span className="fw-fac-cell">
          <span className="fw-fac-ellipsis">{data.packages.length > 0 ? data.packages.map((pkg) => t(`package.${pkg}.title`)).join(' · ') : '—'}</span>
          <span className="fw-fac-cell-sub">{t('history.documents', { count: total, changed, removed })}</span>
        </span>
      )
    }
    const MadeCell = ({ data }: ICellRendererParams<ExportRow>) => {
      if (!data) return null
      const who = data.exportedBy?.name ?? data.madeBy?.name ?? null
      const when = data.exportedAt ?? data.cancelledAt ?? data.createdAt
      return (
        <span className="fw-fac-cell">
          <span className="fw-fac-ellipsis">{who ?? t('history.someone')}</span>
          <span className="fw-fac-cell-sub">{formatDateTime(when, { locale })}</span>
        </span>
      )
    }
    const FilesCell = ({ data }: ICellRendererParams<ExportRow>) =>
      data ? (
        <span className="fw-fac-cell">
          {data.files.length > 0 ? (
            <Link className="fw-fac-link" href={filesHref(model.prefix, [data.id])} target="_blank" rel="noopener noreferrer">
              {t('history.files', { count: data.files.length })}
            </Link>
          ) : (
            <span className="fw-fac-muted">{t('history.noFiles')}</span>
          )}
          <span className="fw-fac-cell-sub">{t('layout.short')}</span>
        </span>
      ) : null
    const ChangedCell = ({ data }: ICellRendererParams<ExportRow>) => {
      if (!data) return null
      if (data.supersededBy) return <span className="fw-fac-muted">{t('history.amendedBy', { number: data.supersededBy.number ?? '—' })}</span>
      if (!data.changedSince) return <span className="fw-fac-muted">—</span>
      if (data.changedSince.count === 0) return <Pill tone="success">{t('history.upToDate')}</Pill>
      const held = reExportHeld(data, model.can)
      return (
        <span className="fw-fac-inline">
          <Pill tone="warning">{t('history.changedSince', { count: data.changedSince.count })}</Pill>
          <Button asChild={!held} size="sm" heldReason={held ? t(held.key, held.params) : undefined}>
            {held ? t('history.reExport') : <Link href={wizardHref(model.prefix, data.period.month, 'checks')}>{t('history.reExport')}</Link>}
          </Button>
        </span>
      )
    }
    const MoreCell = ({ data }: ICellRendererParams<ExportRow>) => {
      if (!data) return null
      const reHeld = reExportHeld(data, model.can)
      const cancel = cancelHeld(data, model.can)
      return (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('history.rowMenu', { number: data.number ?? t(`status.${data.status}`), month: monthWords(data.period.month, locale) }) }}
          items={[
            data.files.length > 0
              ? { id: 'files', label: t('history.openFiles'), href: filesHref(model.prefix, [data.id]), target: '_blank' as const }
              : { id: 'files', label: t('history.openFiles'), disabled: true, description: t(rowSelectable(data)?.key ?? 'history.unselectable.noFiles') },
            reHeld ? { id: 're', label: t('history.reExport'), disabled: true, description: t(reHeld.key, reHeld.params) } : { id: 're', label: t('history.reExport'), href: wizardHref(model.prefix, data.period.month, 'checks') },
            cancel ? { id: 'cancel', label: t('history.cancelDraft'), disabled: true, description: t(cancel.key) } : { id: 'cancel', label: t('history.cancelDraft'), tone: 'danger' as const, onSelect: () => actions?.onCancelDraft?.(data) },
            { id: 'lock', label: t('history.lockMonth', { month: monthWords(data.period.month, locale) }), onSelect: () => actions?.onOpenLock?.(data.period.month) },
          ]}
        />
      )
    }
    return [
      { colId: 'batch', headerName: t('history.col.batch'), minWidth: 150, flex: 0.9, cellRenderer: BatchCell },
      { colId: 'period', headerName: t('history.col.period'), minWidth: 150, flex: 0.9, cellRenderer: PeriodCell },
      { colId: 'contents', headerName: t('history.col.contents'), minWidth: 220, flex: 1.6, cellRenderer: ContentsCell },
      { colId: 'made', headerName: t('history.col.made'), minWidth: 160, flex: 1, cellRenderer: MadeCell },
      { colId: 'files', headerName: t('history.col.files'), minWidth: 170, flex: 0.8, cellRenderer: FilesCell },
      { colId: 'changed', headerName: t('history.col.changed'), minWidth: 230, flex: 1.3, cellRenderer: ChangedCell },
      { colId: 'more', headerName: t('history.col.more'), minWidth: 72, maxWidth: 72, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
  }, [t, locale, model.prefix, model.can, actions])

  const picked = (rows ?? []).filter((row) => selected.includes(row.id))
  const filtered = model.address.status !== null || model.address.year !== null
  const newButton = (
    <Button size="sm" variant="primary" heldReason={model.can.export ? undefined : t('held.noExport')} asChild={model.can.export}>
      {model.can.export ? (
        <Link href={wizardHref(model.prefix, null)}>
          <Plus size={14} aria-hidden /> {t('band.new')}
        </Link>
      ) : (
        <>
          <Plus size={14} aria-hidden /> {t('band.new')}
        </>
      )}
    </Button>
  )
  const state = model.history.problem ? (
    <EmptyState title={t('history.failed')} description={t(model.history.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('common.retry')}</Button>} />
  ) : rows && rows.length === 0 ? (
    filtered ? (
      <EmptyState
        title={t('history.noMatch.title')}
        description={t('history.noMatch.body')}
        action={
          <Button
            size="sm"
            onClick={() => {
              actions?.onStatus?.(null)
              actions?.onYear?.(null)
            }}
          >
            {t('history.clearFilters')}
          </Button>
        }
      />
    ) : (
      <EmptyState title={t('history.empty.title')} description={t('history.empty.body')} action={newButton} />
    )
  ) : undefined
  const thisYear = Number(model.today.slice(0, 4))
  const tools = (
    <span className="fw-fac-inline">
      <Select size="sm" aria-label={t('history.statusLabel')} value={model.address.status ?? ''} onChange={(event) => actions?.onStatus?.((event.target.value || null) as ExportStatus | null)}>
        <option value="">{t('history.allStatuses')}</option>
        {EXPORT_STATUSES.map((status) => (
          <option key={status} value={status}>
            {t(`status.${status}`)}
          </option>
        ))}
      </Select>
      <Select size="sm" aria-label={t('history.yearLabel')} value={model.address.year ? String(model.address.year) : ''} onChange={(event) => actions?.onYear?.(event.target.value ? Number(event.target.value) : null)}>
        <option value="">{t('history.allYears')}</option>
        {[thisYear, thisYear - 1, thisYear - 2].map((year) => (
          <option key={year} value={String(year)}>
            {String(year)}
          </option>
        ))}
      </Select>
    </span>
  )
  const ownKeys: ListKey[] = [{ keys: ['c'], does: t('keys.new') }]

  return (
    <section className="fw-fac-section" aria-labelledby="fw-fac-history-title">
      <div className="fw-fac-section-head">
        <h2 className="fw-fac-h2" id="fw-fac-history-title">
          {t('history.title')}
        </h2>
        <span className="fw-fac-muted">{t('history.lead')}</span>
      </div>
      {model.history.slow && !rows && !model.history.problem && (
        <p className="fw-fac-muted" role="status">
          {t('history.slow')}
        </p>
      )}
      <ListFrame<ExportRow>
        label={t('history.title')}
        rows={state ? [] : rows}
        rowId={(row) => row.id}
        columns={columns}
        count={rows ? t(model.history.more ? 'history.countMore' : 'history.count', { count: rows.length }) : '—'}
        tools={tools}
        selection={{
          selected,
          onChange: setSelected,
          actions: (
            <Button asChild size="sm" variant="primary">
              <a href={filesHref(model.prefix, picked.map((row) => row.id))} target="_blank" rel="noopener noreferrer" aria-label={t('history.bulkFiles', { count: picked.length })}>
                <FolderDown size={13} aria-hidden /> <SelectionLabel>{t('history.bulkFiles', { count: picked.length })}</SelectionLabel>
              </a>
            </Button>
          ),
        }}
        isRowSelectable={(row) => {
          const held = rowSelectable(row)
          return held ? t(held.key) : null
        }}
        updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
        more={model.history.more && rows && rows.length > 0 ? { label: t('history.more'), onMore: () => actions?.onMore?.() } : null}
        keys={ownKeys}
        onHelp={() => setHelp(true)}
        onOpen={(row) => {
          if (row.files.length > 0) window.open(filesHref(model.prefix, [row.id]), '_blank', 'noopener')
        }}
        state={state}
        focusRow={model.focusRow}
        keysOpen={model.keysOpen}
      />
      {help && (
        <Modal open onClose={() => setHelp(false)} title={t('keys.title')} size="sm">
          <ul className="fw-fac-list">
            {listKeys(ownKeys, true).map((entry) => (
              <li key={`${entry.keys.join('+')}-${entry.does}`}>
                <b>{entry.keys.map((key) => (key === 'click' ? lists('keys.click') : key)).join(' ')}</b> — {entry.does.startsWith('keys.') ? lists(entry.does) : entry.does}
              </li>
            ))}
          </ul>
        </Modal>
      )}
    </section>
  )
}
