'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { CalendarClock, CalendarDays, List } from 'lucide-react'
import { EmptyState } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, SegmentedControl } from '@nexus/ui/primitives'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { ScopeSiteChip } from '../../../../shell/scope/view/ScopeSiteChip'
import { CalendarView, DueState } from '../../_shared/calendar/CalendarView'
import type { Chip } from '../api'
import { calendarItems, chipKey, chipMoves, chipRows, chipState, chipTarget, chipWords, preventiveAddressText, typeLabel, withAddress } from '../model'
import type { PreventivePageActions, PreventivePageModel } from '../view-model'
import { CheckLaw, OutcomePill, PAGE_KEYS, SectionFailed, SectionHead, useDay, useWords } from './parts'

/** A chip's own address (Enter, a click, ⌘-click a new tab): its plan or its result, on this page with its filters. */
export function chipHref(model: Pick<PreventivePageModel, 'path' | 'address'>, chip: Chip): string | null {
  const target = chipTarget(chip)
  return target ? `${model.path}${preventiveAddressText(withAddress(model.address, target))}` : null
}

/**
 * The calendar section (design sec calendar): Month (the Plant CalendarView: each day its worst state; the chosen day's
 * agenda — a check's next due date, its later checks by the interval, the checks done; a next due date drags onto another
 * day: Move a check asks why) | List (the list frame over the same chips: Day, Machine, Check, Outside body, State, What).
 * Site from the top bar; with "All sites" a Site column and the chip. A failed read says so with Try again.
 */
export function CalendarSection({ model, actions, onHelp }: { model: PreventivePageModel; actions?: PreventivePageActions | undefined; onHelp: () => void }) {
  const t = useWords()
  const locale = useLocale()
  const day = useDay()
  const { address, scope } = model
  const answer = model.calendar.status === 'ready' ? model.calendar.value : null
  const chips = useMemo(() => answer?.chips ?? null, [answer])
  const byKey = useMemo(() => new Map((chips ?? []).map((chip) => [chipKey(chip), chip])), [chips])
  const items = useMemo(() => (chips ? calendarItems(chips, locale, t, scope.allSites) : null), [chips, locale, t, scope.allSites])
  const moveHeld = model.can.manage ? null : t('held.manage')

  const head = (
    <SectionHead id="fw-pv-calendar" title={t('calendar.title')} note={answer ? t(address.view === 'list' ? 'calendar.windowList' : 'calendar.windowMonth', { from: day(answer.from), to: day(answer.to) }) : null}>
      <SegmentedControl
        size="sm"
        ariaLabel={t('calendar.mode')}
        value={address.view}
        onChange={(view) => actions?.onAddress?.({ view: view === 'list' ? 'list' : 'month' })}
        options={[
          { value: 'month', label: t('calendar.month'), icon: <CalendarDays size={13} aria-hidden /> },
          { value: 'list', label: t('calendar.list'), icon: <List size={13} aria-hidden /> },
        ]}
      />
      <ScopeSiteChip model={scope} />
    </SectionHead>
  )

  if (model.calendar.status === 'error') {
    return (
      <>
        {head}
        <SectionFailed title={t('calendar.failed')} problem={model.calendar.problem} onRetry={actions?.onRetryCalendar} />
      </>
    )
  }

  const empty = chips !== null && chips.length === 0
  const emptyState = (
    <EmptyState
      icon={<CalendarDays size={22} aria-hidden />}
      title={t('calendar.emptyTitle')}
      description={t('calendar.empty')}
      action={
        <Button size="sm" variant="primary" heldReason={moveHeld} onClick={() => actions?.onAddress?.({ newPlan: true })}>
          {t('band.newPlan')}
        </Button>
      }
    />
  )

  return (
    <>
      {head}
      {address.view === 'month' ? (
        empty ? (
          emptyState
        ) : (
          <CalendarView
            label={t('calendar.label', { site: scope.site?.name ?? t('site.all') })}
            items={items}
            month={model.month}
            onMonth={(month) => actions?.onAddress?.({ month, day: null })}
            today={model.today}
            selectedDay={address.day}
            onDay={(next) => actions?.onAddress?.({ day: next })}
            hrefOf={(entry) => {
              const chip = byKey.get(entry.key)
              return chip ? chipHref(model, chip) : null
            }}
            move={{
              canMove: (entry) => model.can.manage && !!byKey.get(entry.key) && chipMoves(byKey.get(entry.key)!),
              onMove: (entry, next) => {
                const chip = byKey.get(entry.key)
                if (chip?.planId) actions?.onAddress?.({ move: chip.planId, date: next })
              },
              hint: model.can.manage ? t('calendar.dragHint') : undefined,
            }}
            loading={model.calendarReading || model.calendar.status === 'loading'}
            note={model.calendar.status === 'loading' ? <span className="fw-pv-slow">{t('common.stillLoading')}</span> : undefined}
          />
        )
      ) : (
        <>
          <ChipList model={model} chips={chips} empty={empty ? emptyState : null} onHelp={onHelp} actions={actions} />
          {model.calendar.status === 'loading' && <span className="fw-pv-slow">{t('common.stillLoading')}</span>}
        </>
      )}
    </>
  )
}

function ChipList({ model, chips, empty, onHelp, actions }: { model: PreventivePageModel; chips: readonly Chip[] | null; empty: ReactNode; onHelp: () => void; actions?: PreventivePageActions | undefined }) {
  const t = useWords()
  const cv = useT('plant-calendar-view')
  const locale = useLocale()
  const day = useDay()
  const { scope } = model
  const rows = useMemo(() => (chips ? chipRows(chips) : null), [chips])
  const [selected, setSelected] = useState<string[]>(() => [...(model.chipSelected ?? [])])
  // A chosen row that left the list (a new read, another month) is no longer chosen.
  useEffect(() => {
    if (rows) setSelected((current) => current.filter((id) => rows.some((row) => chipKey(row) === id)))
  }, [rows])
  const picked = (rows ?? []).filter((row) => selected.includes(chipKey(row)) && chipMoves(row))

  const columns = useMemo<ColDef<Chip>[]>(() => {
    const kindKey = (chip: Chip) => `chipKind.${chip.kind}`
    const built: ColDef<Chip>[] = [
      {
        colId: 'date',
        headerName: t('col.day'),
        minWidth: 170,
        flex: 1,
        valueGetter: (params) => params.data?.date ?? '',
        valueFormatter: (params) => (params.data ? `${day(params.data.date)} · ${t(`state.${chipState(params.data)}`)}` : ''),
        cellRenderer: ({ data }: ICellRendererParams<Chip>) => (data ? <DueState state={chipState(data)} date={data.date} today={model.today} say={cv} /> : null),
      },
      {
        colId: 'check',
        headerName: t('col.check'),
        minWidth: 220,
        flex: 2,
        valueGetter: (params) => (params.data ? typeLabel(params.data.checkType, locale) : ''),
        cellRenderer: ({ data }: ICellRendererParams<Chip>) => {
          if (!data) return null
          const href = chipHref(model, data)
          return (
            <span className="fw-pv-cell">
              {href ? <Link href={href}>{typeLabel(data.checkType, locale)}</Link> : typeLabel(data.checkType, locale)}
              <CheckLaw type={data.checkType} say={t} />
            </span>
          )
        },
      },
      { colId: 'machine', headerName: t('col.machine'), minWidth: 150, flex: 1, valueGetter: (params) => params.data?.machine.assetNumber ?? '' },
      ...(scope.allSites ? [{ colId: 'site', headerName: t('col.site'), minWidth: 140, flex: 1, valueGetter: (params: { data?: Chip }) => params.data?.site.name ?? '' } as ColDef<Chip>] : []),
      { colId: 'body', headerName: t('col.body'), minWidth: 160, flex: 1, valueGetter: (params) => (params.data ? (params.data.outsideBody ?? t('body.inHouse')) : '') },
      {
        colId: 'what',
        headerName: t('col.what'),
        minWidth: 170,
        flex: 1,
        valueGetter: (params) => (params.data ? [t(kindKey(params.data)), ...chipWords(params.data, locale).meta.filter((entry) => entry.key !== 'chip.body' && entry.key !== 'chip.projected' && !entry.key.startsWith('outcome.')).map((entry) => t(entry.key, entry.params))].join(' · ') : ''),
        cellRenderer: ({ data }: ICellRendererParams<Chip>) =>
          data ? (
            <span className="fw-pv-row">
              <span>{t(kindKey(data))}</span>
              {data.outcome ? <OutcomePill outcome={data.outcome} say={t} /> : null}
              {data.machine.locked && data.kind !== 'DONE' ? <span className="fw-pv-warn">{t('chip.locked')}</span> : null}
            </span>
          ) : null,
      },
    ]
    return built
  }, [t, cv, locale, day, scope.allSites, model])

  return (
    <ListFrame<Chip>
      label={t('calendar.listLabel')}
      title={t('calendar.listTitle')}
      listKey={null}
      rows={rows}
      rowId={(row) => chipKey(row)}
      columns={columns}
      count={rows ? t('calendar.listCount', { count: rows.length }) : '—'}
      selection={
        model.can.manage
          ? {
              selected,
              onChange: setSelected,
              actions: (
                <Button size="sm" variant="primary" aria-label={t('bulk.move', { count: picked.length })} heldReason={picked.length === 0 ? t('held.noneDue') : null} onClick={() => actions?.onMoveMany?.([...new Set(picked.map((row) => row.planId!))])}>
                  <CalendarClock size={13} aria-hidden /> <SelectionLabel>{t('bulk.move', { count: picked.length })}</SelectionLabel>
                </Button>
              ),
            }
          : undefined
      }
      isRowSelectable={model.can.manage ? (row) => (chipMoves(row) ? null : t('held.onlyNextDue')) : undefined}
      keys={PAGE_KEYS(t)}
      onHelp={onHelp}
      onOpen={(row) => {
        const target = chipTarget(row)
        if (target) actions?.onAddress?.(target)
      }}
      state={rows && rows.length === 0 ? (empty ?? <EmptyState title={t('calendar.emptyTitle')} description={t('calendar.empty')} />) : undefined}
      cards={{ fields: { check: { role: 'title' } } }}
      today={model.today}
    />
  )
}
