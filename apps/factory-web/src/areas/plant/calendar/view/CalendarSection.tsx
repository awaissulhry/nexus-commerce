'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { CalendarDays, CheckCheck, List, X } from 'lucide-react'
import { Banner, EmptyState } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, SegmentedControl, Tag } from '@nexus/ui/primitives'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { OFFICE_PAGES } from '../../../../shell/nav/office-nav'
import { ScopeSiteChip } from '../../../../shell/scope/view/ScopeSiteChip'
import { CalendarView, DueState } from '../../_shared/calendar/CalendarView'
import type { CalendarViewItem } from '../../_shared/calendar/model'
import type { CalendarItem } from '../api'
import { evidenceKey, failedKey, itemSelectHeld, itemWords, listRows, openTargetOf, pageKey, type OpenTarget } from '../model'
import type { CalendarPageActions, CalendarPageModel } from '../view-model'
import { PAGE_KEYS, say, SectionFailed, SectionHead, useDay, useWords } from './parts'

/** What Enter or a click on an item does: open in place, follow its page, or say where it is kept. */
export function openItem(item: CalendarItem, actions: CalendarPageActions | undefined): void {
  const target = openTargetOf(item, OFFICE_PAGES)
  if (target.kind === 'deadline') actions?.onAddress?.({ open: `DEADLINE:${target.id}` })
  else if (target.kind === 'appointment') actions?.onAddress?.({ appoint: target.id })
  else if (target.kind === 'filing') actions?.onAddress?.({ filing: target.id })
  else if (target.kind === 'link') actions?.onNavigate?.(target.href)
  else actions?.onKept?.(item)
}

/** "Kept on" in words: here, a built page, or a page coming with its step. */
export const keptText = (t: (key: string, params?: Record<string, string | number>) => string, target: OpenTarget): string =>
  target.kind === 'link' ? t(pageKey(target.page)) : target.kind === 'kept' ? t('kept.short', { page: t(pageKey(target.page)) }) : t('kept.here')

/**
 * The calendar section (design sec calendar): Month (the Plant CalendarView: each day its worst state, the chosen day's
 * agenda) | List (the list frame over the same items: Due, What, Site with "All sites", Owner, Evidence, State, Kept on;
 * Mark done N over the open deadlines typed here). A source that failed is said ("Machine checks could not be read"),
 * never drawn as nothing due; a failed read says so with Try again.
 */
export function CalendarSection({ model, actions, onHelp }: { model: CalendarPageModel; actions?: CalendarPageActions | undefined; onHelp: () => void }) {
  const t = useWords()
  const cv = useT('plant-calendar-view')
  const locale = useLocale()
  const day = useDay()
  const { address, scope } = model
  const answer = model.calendar.status === 'ready' ? model.calendar.value : null
  const items = useMemo(() => answer?.items ?? null, [answer])
  const failed = answer?.failed ?? []
  const sentence = (item: CalendarItem) => say(t, itemWords(item, locale))

  const viewItems: CalendarViewItem[] | null = useMemo(
    () =>
      items?.map((item) => ({
        key: item.key,
        date: item.dueOn,
        title: sentence(item),
        state: item.state,
        meta: [item.owner ? t('item.owner', { owner: item.owner }) : null, t(evidenceKey(item.evidence))].filter(Boolean).join(' · '),
        site: scope.allSites ? (item.site?.name ?? t('site.whole')) : null,
      })) ?? null,
    // The words follow the language; the items their read.
    [items, t, locale, scope.allSites],
  )
  const byKey = useMemo(() => new Map((items ?? []).map((item) => [item.key, item])), [items])

  const head = (
    <SectionHead id="fw-hs-calendar" title={t('calendar.title')} note={answer ? t(address.view === 'list' ? 'calendar.windowList' : 'calendar.windowMonth', { from: day(answer.from), to: day(answer.to) }) : null}>
      <SegmentedControl
        size="sm"
        ariaLabel={t('calendar.mode')}
        value={address.view}
        onChange={(view) => actions?.onAddress?.({ view: view === 'list' ? 'list' : 'month', ...(view === 'month' ? { tile: null } : {}) })}
        options={[
          { value: 'month', label: t('calendar.month'), icon: <CalendarDays size={13} aria-hidden /> },
          { value: 'list', label: t('calendar.list'), icon: <List size={13} aria-hidden /> },
        ]}
      />
      <ScopeSiteChip model={scope} />
    </SectionHead>
  )

  const failedBanner = failed.length > 0 && (
    <Banner tone="warning" title={t('calendar.failedTitle')}>
      <ul className="fw-hs-list">
        {failed.map((kind) => (
          <li key={kind}>{t(failedKey(kind))}</li>
        ))}
      </ul>
      <p className="fw-hs-muted">{t('calendar.failedNote')}</p>
    </Banner>
  )

  if (model.calendar.status === 'error') {
    return (
      <>
        {head}
        <SectionFailed title={t('calendar.failed')} problem={model.calendar.problem} onRetry={actions?.onRetryCalendar} />
      </>
    )
  }

  const empty = items !== null && items.length === 0 && failed.length === 0
  const emptyState = (
    <EmptyState
      icon={<CalendarDays size={22} aria-hidden />}
      title={t('calendar.emptyTitle')}
      description={t('calendar.empty')}
      action={
        model.can.manageCalendar ? (
          <Button size="sm" variant="primary" onClick={() => actions?.onAddress?.({ newDeadline: true })}>
            {t('band.add')}
          </Button>
        ) : undefined
      }
    />
  )

  return (
    <>
      {head}
      {failedBanner}
      {address.view === 'month' ? (
        empty ? (
          emptyState
        ) : (
          <CalendarView
            label={t('calendar.label')}
            items={viewItems}
            month={model.month}
            onMonth={(month) => actions?.onAddress?.({ month, day: null })}
            today={model.today}
            selectedDay={address.day}
            onDay={(next) => actions?.onAddress?.({ day: next })}
            onOpen={(entry) => {
              const item = byKey.get(entry.key)
              if (item) openItem(item, actions)
            }}
            hrefOf={(entry) => {
              const item = byKey.get(entry.key)
              const target = item ? openTargetOf(item, OFFICE_PAGES) : null
              return target?.kind === 'link' ? `${model.prefix}${target.href}` : null
            }}
            loading={model.calendarReading || model.calendar.status === 'loading'}
            note={model.calendar.status === 'loading' ? <span className="fw-hs-slow">{t('common.stillLoading')}</span> : undefined}
          />
        )
      ) : (
        <>
          <CalendarList model={model} actions={actions} items={items} empty={empty ? emptyState : null} onHelp={onHelp} say={cv} />
          {model.calendar.status === 'loading' && <span className="fw-hs-slow">{t('common.stillLoading')}</span>}
        </>
      )}
    </>
  )
}

function CalendarList({ model, actions, items, empty, onHelp, say: cv }: { model: CalendarPageModel; actions?: CalendarPageActions | undefined; items: readonly CalendarItem[] | null; empty: ReactNode; onHelp: () => void; say: (key: string, params?: Record<string, string | number>) => string }) {
  const t = useWords()
  const locale = useLocale()
  const day = useDay()
  const { address, scope } = model
  const [selected, setSelected] = useState<string[]>(() => [...(model.selected ?? [])])
  const rows = useMemo(() => (items ? listRows(items, address.tile) : null), [items, address.tile])
  // A chosen row that left the list (a new read, another tile) is no longer chosen.
  useEffect(() => {
    if (rows) setSelected((current) => current.filter((id) => rows.some((row) => row.key === id)))
  }, [rows])
  const canBulk = model.can.manageCalendar && (model.calendar.status !== 'ready' || model.calendar.value.canManage)
  const picked = (rows ?? []).filter((row) => selected.includes(row.key))

  const columns = useMemo<ColDef<CalendarItem>[]>(() => {
    const WhatCell = ({ data }: ICellRendererParams<CalendarItem>) => {
      if (!data) return null
      const target = openTargetOf(data, OFFICE_PAGES)
      const text = say(t, itemWords(data, locale))
      return (
        <span className="fw-hs-cell">
          {target.kind === 'link' ? (
            <Link href={`${model.prefix}${target.href}`}>{text}</Link>
          ) : target.kind === 'kept' ? (
            <span>{text}</span>
          ) : (
            <Button size="sm" variant="link" wrap onClick={() => openItem(data, actions)}>
              {text}
            </Button>
          )}
          {data.law ? <span className="fw-hs-muted">{data.law}</span> : null}
        </span>
      )
    }
    const KeptCell = ({ data }: ICellRendererParams<CalendarItem>) => {
      if (!data) return null
      const target = openTargetOf(data, OFFICE_PAGES)
      if (target.kind === 'link') return <Link href={`${model.prefix}${target.href}`}>{t(pageKey(target.page))}</Link>
      if (target.kind === 'kept' && target.parentHref) {
        return (
          <span className="fw-hs-cell">
            <span>{keptText(t, target)}</span>
            <Link href={`${model.prefix}${target.parentHref}`}>{t(`parent.${target.parentType === 'Machine' || target.parentType === 'Incident' || target.parentType === 'Employee' ? target.parentType : 'other'}`)}</Link>
          </span>
        )
      }
      return <span>{keptText(t, target)}</span>
    }
    // The export reads these column ids (the API's export source for `plant.calendar`).
    const siteColumn: ColDef<CalendarItem> = { colId: 'site', headerName: t('col.site'), minWidth: 140, flex: 1, valueGetter: (params) => (params.data ? (params.data.site?.name ?? t('site.whole')) : '') }
    const columnsBuilt: ColDef<CalendarItem>[] = [
      {
        colId: 'dueOn',
        headerName: t('col.dueOn'),
        minWidth: 170,
        flex: 1,
        valueGetter: (params) => params.data?.dueOn ?? '',
        valueFormatter: (params) => (params.data ? `${day(params.data.dueOn)} · ${t(`state.${params.data.state}`)}` : ''),
        cellRenderer: ({ data }: ICellRendererParams<CalendarItem>) => (data ? <DueState state={data.state} date={data.dueOn} today={model.today} say={cv} /> : null),
      },
      { colId: 'what', headerName: t('col.what'), minWidth: 280, flex: 3, valueGetter: (params) => (params.data ? say(t, itemWords(params.data, locale)) : ''), cellRenderer: WhatCell },
      ...(scope.allSites ? [siteColumn] : []),
      { colId: 'owner', headerName: t('col.owner'), minWidth: 140, flex: 1, valueGetter: (params) => (params.data ? (params.data.owner ?? t('owner.none')) : '') },
      { colId: 'evidence', headerName: t('col.evidence'), minWidth: 150, flex: 1, valueGetter: (params) => (params.data ? t(evidenceKey(params.data.evidence)) : '') },
      { colId: 'state', headerName: t('col.state'), minWidth: 130, flex: 1, valueGetter: (params) => (params.data ? t(`state.${params.data.state}`) : '') },
      { colId: 'keptOn', headerName: t('col.keptOn'), minWidth: 190, flex: 1.4, valueGetter: (params) => (params.data ? keptText(t, openTargetOf(params.data, OFFICE_PAGES)) : ''), cellRenderer: KeptCell },
    ]
    return columnsBuilt
  }, [t, cv, locale, day, scope.allSites, model.prefix, model.today, actions])

  const tools = address.tile ? (
    <span className="fw-hs-tools">
      <Tag tone={address.tile === 'overdue' ? 'danger' : 'warning'}>{t(`tile.${address.tile}.label`)}</Tag>
      <Button size="sm" variant="quiet" onClick={() => actions?.onAddress?.({ tile: null, view: 'list' })}>
        <X size={13} aria-hidden /> {t('list.clearTile')}
      </Button>
    </span>
  ) : null

  return (
    <ListFrame<CalendarItem>
      label={t('list.label')}
      title={t('list.title')}
      listKey="plant.calendar"
      rows={rows}
      rowId={(row) => row.key}
      columns={columns}
      count={rows ? t('list.count', { count: rows.length }) : '—'}
      tools={tools}
      selection={
        canBulk
          ? {
              selected,
              onChange: setSelected,
              actions: (
                <Button
                  size="sm"
                  variant="primary"
                  aria-label={t('bulk.done', { count: picked.length })}
                  heldReason={model.bulkBusy ? t('held.saving') : picked.length === 0 ? t('held.noneOpen') : null}
                  onClick={() => {
                    void actions?.onBulkDone?.(picked)?.then(() => setSelected([]))
                  }}
                >
                  <CheckCheck size={13} aria-hidden /> <SelectionLabel>{t('bulk.done', { count: picked.length })}</SelectionLabel>
                </Button>
              ),
            }
          : undefined
      }
      isRowSelectable={canBulk ? (row) => (itemSelectHeld(row) ? t(itemSelectHeld(row)!) : null) : undefined}
      keys={PAGE_KEYS(t)}
      onHelp={onHelp}
      onOpen={(row) => openItem(row, actions)}
      state={rows && rows.length === 0 ? (empty ?? <EmptyState title={t('list.noneTitle')} description={t('list.none')} />) : undefined}
      cards={{ fields: { what: { role: 'title' } } }}
      today={model.today}
    />
  )
}
