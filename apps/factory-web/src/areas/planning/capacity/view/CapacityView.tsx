'use client'

import { useEffect, useMemo, useState, type MouseEvent, type ReactNode } from 'react'
import Link from 'next/link'
import { ChartGantt, Download, Info, MoreHorizontal, ShieldOff } from 'lucide-react'
import { Banner, Card, DateField, DetailPopover, EmptyState, Menu, MetricStrip, Modal } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { LoadBar } from '@nexus/ui/patterns/planning-board/index'
import { Button, SegmentedControl, Select, Skeleton, Tag } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { listKeys, type ListKey } from '../../../../list-frame/model'
import { formatDateTime } from '../../../../lib/i18n/format'
import { INTL_LOCALE } from '../../../../lib/i18n/locales'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { BOARD_KIT_NAMESPACE, useBoardWords } from '../../../_shared/planning-board/words'
import { CAPACITY_BUCKETS, type CapacityCell, type CapacityLane } from '../api'
import { boardHref, bucketLabel, calendarHref, cellKeyOf, dayWords, howWords, laneEnd, laneNotes, lanesOf, minutesText, NAMESPACE, queryOf, TILE_IDS, todayCell, withFrom, type Words } from '../model'
import type { CapacityActions, CapacityModel } from '../view-model'
import { CellDetail } from './CellDetail'
import '../capacity.css'

export type { CapacityActions, CapacityModel } from '../view-model'

const laneKeyOf = (lane: { kind: string; id: string }) => `${lane.kind}:${lane.id}`

/**
 * SCR-123 — Planning › Capacity & load (design planning.capacity, a report): the band (site, the period with two dates,
 * Day / Week / Month, as of; Open planning board in a window of its own; ⋯ Export, Print, Capacity settings, keys), the
 * tiles Capacity at a glance (each filters the table: lanes over 100 % this week, free minutes in the next four weeks,
 * the most loaded lane), and Load against capacity on the shared list frame: one row per line and work centre, one
 * column per bucket with the DS LoadBar (booked of available minutes, the percent, over capacity said in words) — the
 * bar opens the bucket's orders (DetailModal, J / K across cells), the ⓘ beside it says how the capacity is made — then
 * the whole period and the row end (efficiency used, people, shift pattern). The lane's name opens the board on it.
 */
export function CapacityView({ model, actions }: { model: CapacityModel; actions?: CapacityActions }) {
  return (
    <WithMessages namespaces={[NAMESPACE, BOARD_KIT_NAMESPACE, 'lists']}>
      <CapacityScreen model={model} actions={actions} />
    </WithMessages>
  )
}

function CapacityScreen({ model, actions }: { model: CapacityModel; actions?: CapacityActions }) {
  const t = useT(NAMESPACE)
  const locale = useLocale()
  const words: Words = useMemo(() => ({ t, locale }), [t, locale])
  const kit = useBoardWords()
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  useEffect(() => setSelected(model.selected ?? []), [model.selected])

  const data = model.capacity.status === 'ready' ? model.capacity.value : null
  const lanes = useMemo(() => (data ? lanesOf(data, model.controls.tile) : null), [data, model.controls.tile])
  const lanesKey = lanes?.map(laneKeyOf).join(',') ?? ''
  useEffect(() => setSelected((current) => current.filter((key) => lanesKey.includes(key))), [lanesKey])
  const picked = (lanes ?? []).filter((lane) => selected.includes(laneKeyOf(lane)))

  if (!model.canView) {
    return (
      <div className="fw-pc">
        <Card padded>
          <EmptyState icon={<ShieldOff size={24} aria-hidden />} title={t('noAccess.title')} description={t('noAccess.body')} />
        </Card>
      </div>
    )
  }

  const sites = model.sites.status === 'ready' ? model.sites.value : []
  const site = sites.find((entry) => entry.id === model.siteId) ?? null
  const ownKeys: ListKey[] = [{ keys: ['Enter'], does: t('keys.cell') }]
  const shownFrom = model.controls.from ?? data?.from ?? ''
  const shownTo = model.controls.to ?? data?.to ?? ''
  const cellHref = (key: string) => `${model.prefix}/planning/capacity?${queryOf({ ...model.controls, cell: key })}`

  const LaneCell = ({ data: lane }: ICellRendererParams<CapacityLane>) => {
    if (!lane) return null
    const notes = laneNotes(lane, words)
    return (
      <span className="fw-pc-cell">
        <a className="fw-pc-link fw-pc-ellipsis" href={boardHref(model.prefix, model.siteId, [lane], data?.from)} target="_blank" rel="noreferrer" title={t('lane.toBoard', { lane: lane.name })}>
          {lane.name}
        </a>
        <span className="fw-pc-cell-sub fw-pc-ellipsis">
          {lane.code} · {t(`kind.${lane.kind}`)}
          {lane.kind === 'WORK_CENTRE' && lane.workCentreKind ? ` · ${lane.workCentreKind}` : ''}
        </span>
        {notes.length > 0 && (
          <span className="fw-pc-cell-sub fw-pc-ellipsis" title={notes.join(' · ')}>
            {notes.join(' · ')}
          </span>
        )}
      </span>
    )
  }
  const LoadCell = (lane: CapacityLane, cell: CapacityCell | undefined, bucketName: string) => {
    if (!cell) return <span className="fw-pc-cell-sub">—</span>
    const key = cellKeyOf(lane, cell.key)
    const label = t('cell.title', { lane: lane.name, bucket: bucketName })
    const open = (event: MouseEvent<HTMLAnchorElement>) => {
      if (!actions?.onCell || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
      event.preventDefault()
      actions.onCell(key)
    }
    return (
      <span className="fw-pc-load">
        <Link className="fw-pc-open" href={cellHref(key)} onClick={open} aria-label={t('cell.open', { what: label })}>
          <LoadBar size="sm" label={label} booked={Number(cell.bookedMinutes)} available={Number(cell.availableMinutes)} words={kit.load} locale={INTL_LOCALE[locale]} />
        </Link>
        <HowPopover lane={lane} cell={cell} label={label} words={words} prefix={model.prefix} siteId={model.siteId} />
      </span>
    )
  }
  const OverallCell = ({ data: lane }: ICellRendererParams<CapacityLane>) =>
    lane ? (
      <span className="fw-pc-load">
        <span className="fw-pc-open">
          <LoadBar size="sm" label={t('col.overallOf', { lane: lane.name })} booked={Number(lane.overall.bookedMinutes)} available={Number(lane.overall.availableMinutes)} words={kit.load} locale={INTL_LOCALE[locale]} />
        </span>
      </span>
    ) : null
  const EndCell = ({ data: lane }: ICellRendererParams<CapacityLane>) => {
    if (!lane) return null
    const end = laneEnd(lane, words)
    return (
      <span className="fw-pc-cell" title={end.full}>
        <span className="fw-pc-ellipsis">{end.efficiency}</span>
        <span className="fw-pc-cell-sub fw-pc-ellipsis">{end.people}</span>
        <span className="fw-pc-cell-sub fw-pc-ellipsis">{end.pattern}</span>
      </span>
    )
  }

  const columns: ColDef<CapacityLane>[] = [
    { colId: 'lane', headerName: t('col.lane'), minWidth: 210, flex: 1.4, pinned: 'left', cellRenderer: LaneCell },
    ...(data?.buckets ?? []).map((bucket) => {
      const name = bucketLabel(bucket, words)
      return {
        colId: `b:${bucket.key}`,
        headerName: name,
        headerTooltip: t('col.bucketTip', { bucket: name }),
        minWidth: bucket.kind === 'DAY' ? 128 : 150,
        flex: 1,
        sortable: false,
        cellRenderer: ({ data: lane }: ICellRendererParams<CapacityLane>) => (lane ? LoadCell(lane, lane.cells.find((cell) => cell.key === bucket.key), name) : null),
      } satisfies ColDef<CapacityLane>
    }),
    { colId: 'overall', headerName: t('col.overall'), minWidth: 150, flex: 1, sortable: false, cellRenderer: OverallCell },
    { colId: 'end', headerName: t('col.end'), minWidth: 200, flex: 1.1, sortable: false, cellRenderer: EndCell },
  ]

  let state: ReactNode = undefined
  if (model.capacity.status === 'error') {
    const period = model.capacity.problem.startsWith('period.')
    state = <EmptyState title={t(period ? 'error.periodTitle' : 'error.title')} description={t(model.capacity.problem)} action={period ? undefined : <Button size="sm" onClick={() => actions?.onRetry?.()}>{t('common.retry')}</Button>} />
  } else if (data && data.lanes.length === 0) {
    state = (
      <EmptyState
        title={t('empty.title')}
        description={t('empty.body')}
        action={
          <Button size="sm" asChild>
            <Link href={`${model.prefix}/planning/settings?tab=efficiency`}>{t('empty.settings')}</Link>
          </Button>
        }
      />
    )
  } else if (lanes && lanes.length === 0) {
    state = <EmptyState title={t('empty.tileTitle')} description={t(`empty.tile.${model.controls.tile ?? 'over'}`)} action={<Button size="sm" onClick={() => actions?.onTile?.(null)}>{t('common.clearFilters')}</Button>} />
  }

  const most = data?.tiles.mostLoadedThisWeek ?? null
  const mostLane = most && data ? data.lanes.find((lane) => lane.kind === most.kind && lane.id === most.id) : null
  const tiles = TILE_IDS.map((id) => {
    const value = !data
      ? '—'
      : id === 'over'
        ? String(data.tiles.lanesOverThisWeek)
        : id === 'free'
          ? t('tile.minutes', { minutes: minutesText(data.tiles.freeMinutesNext4Weeks.lines, locale) })
          : most
            ? t('tile.mostValue', { lane: mostLane?.name ?? most.code, pct: minutesText(most.loadPct, locale) })
            : '—'
    const hint = id !== 'free' ? t(`tile.hint.${id}`) : data ? t('tile.hint.free', { minutes: minutesText(data.tiles.freeMinutesNext4Weeks.workCentres, locale) }) : undefined
    return { label: t(`tile.${id}`), value, hint, onClick: () => actions?.onTile?.(model.controls.tile === id ? null : id), active: model.controls.tile === id }
  })
  const cellOpen = model.controls.cell && data ? model.controls.cell : null

  return (
    <div className="fw-pc">
      <div className="fw-pc-head">
        <span className="fw-pc-status" role="status">
          {model.capacity.status === 'loading' ? <Skeleton width={160} height={18} /> : data ? t('page.asOf', { time: formatDateTime(data.asOf, { locale, timeZone: data.site.timeZone }) }) : null}
          {' · '}
          {t(`live.${model.live}`)}
        </span>
        <span className="fw-pc-inline fw-pc-actions">
          {sites.length > 1 && (
            <Select size="sm" aria-label={t('page.site')} value={model.siteId ?? ''} onChange={(event) => actions?.onSite?.(event.target.value)}>
              {sites.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.code} · {entry.name}
                </option>
              ))}
            </Select>
          )}
          {sites.length === 1 && site && <span className="fw-pc-hint">{t('page.siteOne', { site: `${site.code} · ${site.name}` })}</span>}
          <span className="fw-pc-inline">
            <span className="fw-pc-date">
              <DateField value={shownFrom} onChange={(value) => value && actions?.onPeriod?.(withFrom(model.controls, value, data ? { from: data.from, to: data.to } : null))} locale={INTL_LOCALE[locale]} ariaLabel={t('page.from')} />
            </span>
            <span className="fw-pc-hint">–</span>
            <span className="fw-pc-date">
              <DateField value={shownTo} min={shownFrom || undefined} onChange={(value) => value && actions?.onPeriod?.({ from: shownFrom || null, to: value })} locale={INTL_LOCALE[locale]} ariaLabel={t('page.to')} />
            </span>
          </span>
          <SegmentedControl size="sm" ariaLabel={t('page.bucket')} value={model.controls.bucket} onChange={(value) => actions?.onBucket?.(value as (typeof CAPACITY_BUCKETS)[number])} options={CAPACITY_BUCKETS.map((bucket) => ({ value: bucket, label: t(`bucket.${bucket}`) }))} />
          <Button size="sm" asChild>
            <a href={boardHref(model.prefix, model.siteId, [], data?.from)} target="_blank" rel="noreferrer">
              <ChartGantt size={13} aria-hidden /> {t('page.board')}
            </a>
          </Button>
          <Menu
            label={<MoreHorizontal size={16} aria-hidden />}
            align="right"
            triggerProps={{ 'aria-label': t('page.more') }}
            items={[
              { id: 'export', label: t('page.export'), onSelect: () => actions?.onExport?.([]), disabled: !data || data.lanes.length === 0 },
              { id: 'print', label: t('page.print'), onSelect: () => actions?.onPrint?.(), disabled: !data },
              { id: 'settings', label: t('page.settings'), href: `${model.prefix}/planning/settings?${model.siteId ? `site=${encodeURIComponent(model.siteId)}&` : ''}tab=efficiency` },
              { id: 'keys', label: t('page.keys'), onSelect: () => actions?.onKeys?.() },
            ]}
          />
        </span>
      </div>
      {data && (
        <p className="fw-pc-print">
          {t('page.printHead', { site: `${data.site.code} · ${data.site.name}`, from: dayWords(data.from, locale), to: dayWords(data.to, locale), bucket: t(`bucket.${model.controls.bucket}`) })}
        </p>
      )}

      {model.sites.status === 'ready' && sites.length === 0 && <Banner tone="info" title={t('page.noSites')} />}
      {data && data.workOrdersWithoutLine > 0 && <Banner tone="info" title={t('page.withoutLine', { count: data.workOrdersWithoutLine })} />}

      <section aria-label={t('tile.title')}>
        <MetricStrip metrics={tiles} />
      </section>

      <ListFrame<CapacityLane>
        label={t('list.label')}
        rows={state ? [] : lanes}
        rowId={laneKeyOf}
        columns={columns}
        count={lanes ? t('list.count', { count: lanes.length }) : '—'}
        tools={model.controls.tile ? <Tag tone="info">{t(`tile.${model.controls.tile}`)}</Tag> : undefined}
        selection={{
          selected,
          onChange: setSelected,
          actions: (
            <>
              <Button size="sm" variant="primary" asChild>
                <a href={boardHref(model.prefix, model.siteId, picked, data?.from)} target="_blank" rel="noreferrer" aria-label={t('bulk.board', { count: picked.length })}>
                  <ChartGantt size={13} aria-hidden /> <SelectionLabel>{t('bulk.board', { count: picked.length })}</SelectionLabel>
                </a>
              </Button>
              <Button size="sm" aria-label={t('bulk.export', { count: picked.length })} onClick={() => actions?.onExport?.(picked.map(laneKeyOf))}>
                <Download size={13} aria-hidden /> <SelectionLabel>{t('bulk.export', { count: picked.length })}</SelectionLabel>
              </Button>
            </>
          ),
        }}
        rowKind="media"
        updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
        keys={ownKeys}
        onHelp={() => actions?.onKeys?.()}
        onOpen={(lane) => {
          const cell = data ? (todayCell(lane, data.today) ?? lane.cells[0]) : null
          if (cell) actions?.onCell?.(cellKeyOf(lane, cell.key))
        }}
        state={state}
        focusRow={model.focusRow}
        keysOpen={model.keysOpen}
      />
      <p className="fw-pc-hint">{t('list.note')}</p>

      {cellOpen && data && <CellDetail model={model} actions={actions} data={data} lanes={lanes ?? []} words={words} />}
      {model.dialog?.kind === 'keys' && (
        <Modal open onClose={() => actions?.onCloseDialog?.()} title={t('page.keys')} size="sm">
          <KeysList ownKeys={ownKeys} t={t} />
        </Modal>
      )}
    </div>
  )
}

function KeysList({ ownKeys, t }: { ownKeys: readonly ListKey[]; t: (key: string) => string }) {
  const lists = useT('lists')
  return (
    <ul className="fw-pc-list">
      {listKeys(ownKeys, true).map((entry) => (
        <li key={entry.does}>
          <b>{entry.keys.join(' ')}</b> — {entry.does.startsWith('keys.') ? lists(entry.does) : entry.does}
        </li>
      ))}
      <li>
        <b>J K</b> — {t('keys.walk')}
      </li>
    </ul>
  )
}

/** "How this capacity is made" (design pop:how), on the cell's ⓘ: the formula, closed days, the link to the calendar. */
function HowPopover({ lane, cell, label, words, prefix, siteId }: { lane: CapacityLane; cell: CapacityCell; label: string; words: Words; prefix: string; siteId: string | null }) {
  const { t } = words
  const lines = howWords(lane, cell, words)
  const calendar = lane.calendars[0] ?? null
  return (
    <DetailPopover trigger={<Info size={13} aria-hidden />} triggerLabel={t('how.trigger', { what: label, how: lines[0] ?? '' })} label={t('how.title', { what: label })} hoverDelay={0}>
      <div className="fw-pc-how">
        <b>{t('how.title', { what: label })}</b>
        <ul className="fw-pc-list">
          {lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        {calendar ? (
          <Link className="fw-pc-link" href={calendarHref(prefix, siteId, calendar.id)}>{t('how.calendar', { name: calendar.name })}</Link>
        ) : (
          <span className="fw-pc-hint">{t('how.noCalendar')}</span>
        )}
      </div>
    </DetailPopover>
  )
}

