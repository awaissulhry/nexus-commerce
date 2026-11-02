'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { CheckCheck, Search } from 'lucide-react'
import { EmptyState } from '@nexus/ui/components'
import { actionsColumn, SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Tag } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../list-frame/ListFrame'
import type { ListKey } from '../../../../list-frame/model'
import { useLocale } from '../../../../lib/i18n/provider'
import { siteColumn } from '../../../../shell/scope/scope-context'
import type { InboxItem } from '../api'
import { agePhrase, codeWords, dayTargets, itemKey, normalTargets, rowApproveHeld, rowHeld, rowRejectHeld } from '../model'
import type { LabourActions, LabourModel } from './LabourView'
import { AgeCell, ChangeList, dayText, KindPill, say, useLabourT, useValueWords } from './parts'

/**
 * To decide (design lb-queue): ONE queue of correction requests, disputes, off-standard blocks and line days to close, oldest
 * first, on the shared list frame. Columns: kind · line · date · work order / bundle / operation · what changes (ChangeValue
 * from → to) · age; never who: the design's "raised by" column is left out (a person in a list, Owner W1). A row opens its
 * DetailModal (`?open=`); Approve and Reject are its verbs (DS rowVerbs); selected rows offer "Approve N normal blocks" (large
 * or unusual blocks cannot be ticked, and say why on their box) and "Close N days".
 */
export function QueueList({ model, actions, filtered, selected, onSelected }: { model: LabourModel; actions?: LabourActions; filtered: readonly InboxItem[] | null; selected: readonly string[]; onSelected: (keys: string[]) => void }) {
  const t = useLabourT()
  const locale = useLocale()
  const words = useValueWords(model.codes, model.timeZone)
  const [query, setQuery] = useState(model.address.q)
  useEffect(() => setQuery(model.address.q), [model.address.q])
  const typed = useRef(false)
  const latest = useRef({ actions, model })
  latest.current = { actions, model }
  useEffect(() => {
    if (!typed.current) return
    const timer = setTimeout(() => latest.current.actions?.onAddress?.({ q: query }), 300)
    return () => clearTimeout(timer)
  }, [query])

  const columns = useMemo<ColDef<InboxItem>[]>(() => {
    const code = (item: InboxItem) => codeWords(item.code, latest.current.model.codes, locale)
    const Kind = ({ data }: ICellRendererParams<InboxItem>) => (data ? <KindPill kind={data.kind} /> : null)
    const Line = ({ data }: ICellRendererParams<InboxItem>) =>
      data ? (
        <span className="fw-lb-cell">
          <span className="fw-lb-ellipsis">{data.line?.code ?? '—'}</span>
          {data.line && <span className="fw-lb-sub fw-lb-ellipsis">{data.line.name}</span>}
        </span>
      ) : null
    const Date = ({ data }: ICellRendererParams<InboxItem>) => (data ? <span className="fw-lb-num">{dayText(data.workDate, locale, model.timeZone)}</span> : null)
    const Work = ({ data }: ICellRendererParams<InboxItem>) => {
      if (!data) return null
      if (!data.workOrder && !data.bundle && !data.operation) return <span className="fw-lb-sub">—</span>
      const can = latest.current.model.can.workOrders
      return (
        <span className="fw-lb-cell">
          {data.workOrder ? (
            can ? (
              <Link className="fw-lb-link" href={`${latest.current.model.prefix}/production/work-orders/${data.workOrder.id}`}>
                {data.workOrder.number}
              </Link>
            ) : (
              <span>{data.workOrder.number}</span>
            )
          ) : null}
          <span className="fw-lb-sub fw-lb-ellipsis">{[data.bundle?.code, data.operation ? `${data.operation.seq} ${data.operation.name}` : null].filter(Boolean).join(' · ')}</span>
        </span>
      )
    }
    const What = ({ data }: ICellRendererParams<InboxItem>) => {
      if (!data) return null
      if (data.kind === 'CORRECTION') return <ChangeList changes={data.changes} words={words} compact />
      if (data.kind === 'DISPUTE')
        return (
          <span className="fw-lb-cell">
            <span className="fw-lb-ellipsis">{t(data.code ? `dispute.reason.${data.code}` : 'dispute.noReason')}</span>
            <span className="fw-lb-sub">{t(data.recordType === 'OffStandardEntry' ? 'dispute.aboutBlock' : 'dispute.aboutReport')}</span>
          </span>
        )
      if (data.kind === 'OFF_STANDARD')
        return (
          <span className="fw-lb-cell">
            <span className="fw-lb-ellipsis">{t('what.block', { code: code(data) ?? '—', minutes: data.minutes ?? 0 })}</span>
            {data.unusual.length > 0 && (
              <span className="fw-lb-inline">
                {data.unusual.map((reason) => (
                  <Tag key={reason} tone="warning">
                    {t(`unusual.${reason}`)}
                  </Tag>
                ))}
              </span>
            )}
          </span>
        )
      return <span className="fw-lb-ellipsis">{t('what.day')}</span>
    }
    const Age = ({ data }: ICellRendererParams<InboxItem>) => (data ? <AgeCell minutes={data.ageMinutes} /> : null)
    const site = siteColumn<InboxItem>(model.scope, (row) => row.siteId, t('col.site'))
    return [
      { colId: 'kind', headerName: t('col.kind'), minWidth: 170, flex: 0.8, cellRenderer: Kind, valueGetter: (params) => (params.data ? t(`kind.${params.data.kind}`) : '') },
      ...(site ? [site] : []),
      { colId: 'line', headerName: t('col.line'), minWidth: 110, flex: 0.6, cellRenderer: Line, valueGetter: (params) => params.data?.line?.code ?? '' },
      { colId: 'date', headerName: t('col.date'), minWidth: 110, flex: 0.5, cellRenderer: Date, valueGetter: (params) => params.data?.workDate ?? '' },
      { colId: 'work', headerName: t('col.work'), minWidth: 170, flex: 1, cellRenderer: Work, valueGetter: (params) => params.data?.workOrder?.number ?? '' },
      { colId: 'what', headerName: t('col.what'), minWidth: 220, flex: 1.4, cellRenderer: What, sortable: false },
      { colId: 'age', headerName: t('col.age'), minWidth: 104, flex: 0.4, cellRenderer: Age, valueGetter: (params) => params.data?.ageMinutes ?? 0, tooltipValueGetter: (params) => (params.data ? say(t, agePhrase(params.data.ageMinutes)) : '') },
      actionsColumn<InboxItem>({
        primary: (row) => {
          const approve = {
            id: 'approve',
            label: t(`verb.${row.kind}`),
            tone: 'primary' as const,
            onClick: (item: InboxItem) => latest.current.actions?.onApprove?.(item),
            disabled: (item: InboxItem) => {
              const held = rowApproveHeld(item, latest.current.model.can, latest.current.model.busy)
              return held ? t(held) : null
            },
            ariaLabel: (item: InboxItem) => t('verb.named', { verb: t(`verb.${item.kind}`), kind: t(`kind.${item.kind}`), line: item.line?.code ?? '—' }),
          }
          if (row.kind === 'LINE_DAY') return [approve] as const
          return [
            approve,
            {
              id: 'reject',
              label: t('verb.reject'),
              tone: 'danger' as const,
              onClick: (item: InboxItem) => latest.current.actions?.onReject?.(item),
              disabled: (item: InboxItem) => {
                const held = rowRejectHeld(item, latest.current.model.can, latest.current.model.busy)
                return held ? t(held) : null
              },
              ariaLabel: (item: InboxItem) => t('verb.named', { verb: t('verb.reject'), kind: t(`kind.${item.kind}`), line: item.line?.code ?? '—' }),
            },
          ] as const
        },
        prefsLabel: t('col.actions'),
      }),
    ]
  }, [t, locale, model.timeZone, model.scope, words])

  const normal = normalTargets((filtered ?? []).filter((item) => selected.includes(itemKey(item))))
  const days = dayTargets((filtered ?? []).filter((item) => selected.includes(itemKey(item))))
  const narrowed = model.address.q.trim() !== '' || model.address.kind !== null
  const state = model.rows.problem ? (
    <EmptyState title={t('queue.failed')} description={t(model.rows.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('common.retry')}</Button>} />
  ) : filtered && filtered.length === 0 ? (
    narrowed ? (
      <EmptyState
        title={t('queue.noMatch.title')}
        description={t('queue.noMatch.body')}
        action={
          <Button
            size="sm"
            onClick={() => {
              setQuery('')
              actions?.onAddress?.({ q: '', kind: null })
            }}
          >
            {t('common.clearFilters')}
          </Button>
        }
      />
    ) : (
      <EmptyState icon={<CheckCheck size={24} aria-hidden />} title={t('queue.empty.title')} description={t('queue.empty.body')} />
    )
  ) : undefined

  const keys: ListKey[] = [
    { keys: ['A'], does: t('keys.approve') },
    { keys: ['R'], does: t('keys.reject') },
    { keys: ['J', 'K'], does: t('keys.next') },
  ]
  const selecting = model.can.approveBlocks || model.can.close

  return (
    <ListFrame<InboxItem>
      label={t('queue.label')}
      title={t('queue.title')}
      rows={state ? [] : filtered}
      rowId={itemKey}
      columns={columns}
      count={filtered ? t('queue.count', { count: filtered.length }) : '—'}
      search={
        <Input
          size="sm"
          type="search"
          leadingIcon={<Search size={13} aria-hidden />}
          aria-label={t('queue.search')}
          placeholder={t('queue.search')}
          value={query}
          onChange={(event) => {
            typed.current = true
            setQuery(event.target.value)
          }}
        />
      }
      selection={
        selecting
          ? {
              selected,
              onChange: onSelected,
              actions: (
                <>
                  <Button size="sm" variant="primary" aria-label={t('bulk.approve', { count: normal.length })} heldReason={normal.length === 0 ? t('held.noNormalPicked') : model.busy ? t('held.busy') : null} onClick={() => actions?.onApproveNormal?.(normal)}>
                    <CheckCheck size={13} aria-hidden /> <SelectionLabel>{t('bulk.approve', { count: normal.length })}</SelectionLabel>
                  </Button>
                  <Button size="sm" aria-label={t('bulk.close', { count: days.length })} heldReason={days.length === 0 ? t('held.noDayPicked') : model.busy ? t('held.busy') : null} onClick={() => actions?.onCloseItems?.(days)}>
                    <SelectionLabel>{t('bulk.close', { count: days.length })}</SelectionLabel>
                  </Button>
                </>
              ),
            }
          : undefined
      }
      isRowSelectable={(item) => {
        const held = rowHeld(item, model.can)
        if (!held) return null
        return held.key === 'select.unusual' ? t(held.key, { why: item.unusual.map((reason) => t(`unusual.${reason}`)).join(', ') }) : t(held.key)
      }}
      updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
      more={model.rows.more ? { label: t('common.more'), onMore: () => actions?.onMore?.(), held: model.rows.limitReached ? t('held.tooMany') : null } : null}
      keys={keys}
      onHelp={() => actions?.onDialog?.({ kind: 'keys' })}
      onOpen={(item) => actions?.onAddress?.({ open: itemKey(item) })}
      state={state}
      focusRow={model.focusRow}
    />
  )
}
