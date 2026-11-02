'use client'

import { useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { Download, MoreHorizontal, Plus } from 'lucide-react'
import { EmptyState, Menu } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Pill, Select, Tag } from '@nexus/ui/primitives'
import { formatDateTime } from '../../../../lib/i18n/format'
import { useLocale } from '../../../../lib/i18n/provider'
import { ListFrame } from '../../../../list-frame/ListFrame'
import type { ListKey } from '../../../../list-frame/model'
import { TIME_ZONE } from '../../_shared/model'
import type { ExportRow } from '../api'
import { fileHref, monthName, monthWords, recordHref, rowCorrectHeld, sealShort, sendRowHeld } from '../model'
import type { PayrollActions, PayrollModel } from '../view-model'
import { LayoutTag, STATUS_TONE, usePayrollWords, useSaid } from './parts'

const YEARS_BACK = 5

/**
 * Exports (design people.payroll sec:past): every file made, with what changed since the previous one: period, company, format,
 * version, made by and when, sent to, downloaded at, the seal. No money and no person in this list. Open an export (⌘-click its
 * period: a new tab), "Make correction" on the month's latest file, Export N as a CSV of these same columns.
 */
export function ExportsList({ model, actions, onHelp, startHeld, onStart }: { model: PayrollModel; actions?: PayrollActions; onHelp: () => void; startHeld: string | null; onStart: () => void }) {
  const t = usePayrollWords()
  const said = useSaid()
  const locale = useLocale()
  const [selectedOwn, setSelected] = useState<string[]>([])
  const selected = model.selected ? [...model.selected] : selectedOwn
  const rows = model.exports.rows
  const place = useMemo(() => ({ locale, timeZone: TIME_ZONE }), [locale])
  const act = useRef(actions)
  act.current = actions

  const columns = useMemo<ColDef<ExportRow>[]>(() => {
    const PeriodCell = ({ data }: ICellRendererParams<ExportRow>) =>
      data ? (
        <span className="fw-pp-cell">
          <Link className="fw-pp-link fw-pp-ellipsis" href={recordHref(model.prefix, data.id)}>
            {monthWords(data.month, locale)}
          </Link>
          <span className="fw-pp-sub">
            <Pill tone={STATUS_TONE[data.status]}>{t(`status.${data.status}`)}</Pill>
          </span>
        </span>
      ) : null
    const CompanyCell = ({ data }: ICellRendererParams<ExportRow>) =>
      data ? (
        <span className="fw-pp-cell">
          <span className="fw-pp-ellipsis">{data.company.code}</span>
          <span className="fw-pp-sub fw-pp-ellipsis">{data.company.legalName}</span>
        </span>
      ) : null
    const FormatCell = ({ data }: ICellRendererParams<ExportRow>) =>
      data ? (
        <span className="fw-pp-cell">
          <span className="fw-pp-ellipsis">{data.layout.name}</span>
          <span className="fw-pp-sub">
            <LayoutTag layout={data.layout} />
          </span>
        </span>
      ) : null
    const VersionCell = ({ data }: ICellRendererParams<ExportRow>) =>
      data ? (
        <span className="fw-pp-cell">
          <span>{`v${data.revision}`}</span>
          <span className="fw-pp-sub">{data.number ?? t('list.noNumber')}</span>
        </span>
      ) : null
    const MadeCell = ({ data }: ICellRendererParams<ExportRow>) =>
      data ? (
        <span className="fw-pp-cell">
          <span className="fw-pp-ellipsis">{data.madeBy?.name ?? t('list.someone')}</span>
          <span className="fw-pp-sub">{formatDateTime(data.exportedAt ?? data.createdAt, place)}</span>
        </span>
      ) : null
    const SentCell = ({ data }: ICellRendererParams<ExportRow>) =>
      data ? (
        <span className="fw-pp-cell">
          <span className="fw-pp-ellipsis">{data.sentTo.length > 0 ? data.sentTo.join(', ') : t('list.notSent')}</span>
          <span className="fw-pp-sub">{data.downloadedAt ? t('list.downloaded', { at: formatDateTime(data.downloadedAt, place) }) : t('list.notDownloaded')}</span>
        </span>
      ) : null
    const ChangedCell = ({ data }: ICellRendererParams<ExportRow>) => {
      if (!data) return null
      if (data.correctedById) return <Tag tone="neutral">{t('list.replaced')}</Tag>
      return data.changed ? <span>{t('list.changed', { people: data.changed.people, values: data.changed.values })}</span> : <span className="fw-pp-hint">{t('list.firstFile')}</span>
    }
    const SealCell = ({ data }: ICellRendererParams<ExportRow>) => (data ? <span className="fw-pp-code" title={data.seal ?? undefined}>{data.seal ? sealShort(data.seal) : '—'}</span> : null)
    const MoreCell = ({ data }: ICellRendererParams<ExportRow>) => {
      if (!data) return null
      const correct = rowCorrectHeld(data, model.can)
      const send = sendRowHeld(data, model.can)
      const exported = data.status === 'EXPORTED'
      return (
        <Menu
          align="right"
          label={<MoreHorizontal size={16} aria-hidden />}
          triggerProps={{ 'aria-label': t('list.rowMenu', { month: monthWords(data.month, locale), version: data.revision }) }}
          items={[
            { id: 'open', label: t('list.open'), href: recordHref(model.prefix, data.id) },
            exported ? { id: 'summary', label: t('list.summary'), href: fileHref(model.prefix, data.id, 'summary'), target: '_blank' as const } : { id: 'summary', label: t('list.summary'), disabled: true, description: t('held.notExported') },
            send ? { id: 'send', label: t('list.send'), disabled: true, description: said(send) } : { id: 'send', label: t('list.send'), onSelect: () => act.current?.onOpenSend?.(data) },
            correct ? { id: 'correct', label: t('list.correct'), disabled: true, description: said(correct) } : { id: 'correct', label: t('list.correct'), onSelect: () => act.current?.onOpenCorrect?.(data) },
            ...(data.status === 'DRAFT' && model.can.manage ? [{ id: 'cancel', label: t('list.cancel'), tone: 'danger' as const, onSelect: () => act.current?.onOpenCancel?.(data) }] : []),
          ]}
        />
      )
    }
    return [
      { colId: 'period', headerName: t('col.period'), minWidth: 140, flex: 0.9, cellRenderer: PeriodCell },
      { colId: 'company', headerName: t('col.company'), minWidth: 120, flex: 0.8, cellRenderer: CompanyCell },
      { colId: 'format', headerName: t('col.format'), minWidth: 160, flex: 1, cellRenderer: FormatCell },
      { colId: 'version', headerName: t('col.version'), minWidth: 135, flex: 0.6, cellRenderer: VersionCell },
      { colId: 'made', headerName: t('col.made'), minWidth: 145, flex: 0.9, cellRenderer: MadeCell },
      { colId: 'sent', headerName: t('col.sent'), minWidth: 195, flex: 1.3, cellRenderer: SentCell },
      { colId: 'changed', headerName: t('col.changed'), minWidth: 140, flex: 0.7, cellRenderer: ChangedCell },
      { colId: 'seal', headerName: t('col.seal'), minWidth: 120, flex: 0.6, cellRenderer: SealCell },
      { colId: 'more', headerName: t('col.more'), minWidth: 72, maxWidth: 72, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
  }, [t, said, locale, place, model.prefix, model.can])

  const picked = (rows ?? []).filter((row) => selected.includes(row.id))
  const month = model.month.status === 'ready' ? model.month.value.month : null
  const newButton = (
    <Button size="sm" variant="primary" onClick={onStart} heldReason={startHeld}>
      <Plus size={14} aria-hidden /> {month ? t('band.start', { month: monthName(month, locale) }) : t('band.startPlain')}
    </Button>
  )
  const state = model.exports.problem ? (
    <EmptyState title={t('list.failed')} description={t(model.exports.problem === 'problem.forbidden' ? 'problem.forbidden' : 'problem.unavailable')} action={<Button size="sm" onClick={() => actions?.onRetryExports?.()}>{t('common.retry')}</Button>} />
  ) : rows && rows.length === 0 ? (
    model.address.year ? (
      <EmptyState title={t('list.noMatch.title', { year: model.address.year })} description={t('list.noMatch.body')} action={<Button size="sm" onClick={() => actions?.onYear?.(null)}>{t('list.allYears')}</Button>} />
    ) : (
      <EmptyState title={t('list.empty.title')} description={t('list.empty.body')} action={newButton} />
    )
  ) : undefined
  const thisYear = Number(model.today.slice(0, 4))
  const tools = (
    <Select size="sm" aria-label={t('list.yearLabel')} value={model.address.year ? String(model.address.year) : ''} onChange={(event) => actions?.onYear?.(event.target.value ? Number(event.target.value) : null)}>
      <option value="">{t('list.allYears')}</option>
      {Array.from({ length: YEARS_BACK }, (_, index) => thisYear - index).map((year) => (
        <option key={year} value={String(year)}>
          {String(year)}
        </option>
      ))}
    </Select>
  )
  const keys: ListKey[] = [{ keys: ['c'], does: t('keys.start') }]

  return (
    <section className="fw-pay-section" id="past" aria-labelledby="fw-pay-past">
      <div className="fw-pay-section-head">
        <h2 className="fw-pp-h3" id="fw-pay-past">
          {t('list.title')}
        </h2>
        <span className="fw-pp-hint">{t('list.lead')}</span>
      </div>
      {model.exports.slow && !rows && !model.exports.problem && (
        <p className="fw-pp-hint" role="status">
          {t('list.slow')}
        </p>
      )}
      <ListFrame<ExportRow>
        label={t('list.title')}
        rows={state ? [] : rows}
        rowId={(row) => row.id}
        columns={columns}
        count={rows ? t(model.exports.more ? 'list.countMore' : 'list.count', { count: rows.length }) : '—'}
        tools={tools}
        selection={{
          selected,
          onChange: setSelected,
          actions: (
            <Button size="sm" variant="primary" aria-label={t('list.csv', { count: picked.length })} onClick={() => actions?.onExportCsv?.(picked)}>
              <Download size={13} aria-hidden /> <SelectionLabel>{t('list.csv', { count: picked.length })}</SelectionLabel>
            </Button>
          ),
        }}
        updates={model.exports.updates > 0 ? { count: model.exports.updates, onShow: () => actions?.onShowUpdates?.() } : null}
        more={model.exports.more && rows && rows.length > 0 ? { label: t('list.more'), onMore: () => actions?.onMore?.() } : null}
        keys={keys}
        onHelp={onHelp}
        onOpen={(row) => actions?.onOpenExport?.(row.id)}
        state={state}
        focusRow={model.focusRow}
        keysOpen={model.keysOpen}
      />
    </section>
  )
}
