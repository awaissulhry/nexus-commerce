'use client'

import { Fragment, useEffect, useMemo, useRef, type ReactNode } from 'react'
import Link from 'next/link'
import { Download, Hand, MoreHorizontal, Printer, ShieldCheck, UserRound, X } from 'lucide-react'
import { Banner, DetailPopover, EmptyState, Field, Menu, MetricStrip, Modal, type MenuItemDef } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, FilterChip, Input, Kbd, Select, Skeleton } from '@nexus/ui/primitives'
import { formatDate, formatDateTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { recordAddress } from '../../../../lib/records/record-links'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { listKeys, type ListKey } from '../../../../list-frame/model'
import { OFFICE_PAGES } from '../../../../shell/nav/office-nav'
import type { StepUpState } from '../../_shared/hooks'
import { countText } from '../../_shared/model'
import { Freshness, NoAccess, NoticeBanner, PageHead } from '../../_shared/parts'
import type { Hold, HoldDetail } from '../api'
import {
  blocksKey,
  bulkAssignHeld,
  bulkReleaseHeld,
  changeHeld,
  MAX,
  kindKey,
  nounKey,
  ownerWords,
  placedByKey,
  quantityWords,
  quarantineKey,
  reasonText,
  releaseHeld,
  sourceKey,
  SOURCE_RECORD,
  subjectCodes,
  tagAddress,
  TILE_COUNT,
  TILES,
  traceOf,
  VIEWS,
  type HoldsDialog,
  type HoldsListModel,
  type RecordTab,
  type ReleaseDraft,
  type View,
} from '../model'
import { HoldDetailModal } from './HoldDetailModal'
import { HoldPill, HoldsMessages, HoldsStepUp, SaveMark } from './parts'
import { ReleaseHoldDialog } from './ReleaseHoldDialog'

export interface HoldsListActions {
  onView?: (view: View) => void
  onClearScope?: () => void
  onMore?: () => void
  onRetry?: () => void
  onShowUpdates?: () => void
  onSelect?: (ids: readonly string[]) => void
  onOpen?: (holdId: string | null) => void
  onTab?: (tab: RecordTab) => void
  onRetryDetail?: () => void
  onDialog?: (dialog: HoldsDialog | null) => void
  onPlace?: () => void
  onRaiseNcr?: (hold: Hold) => void
  onOwner?: (hold: Hold, ownerId: string | null) => void
  onExpected?: (hold: Hold, day: string | null) => void
  onNote?: (hold: Hold, note: string | null) => void
  onNeedPeople?: (siteId: string) => void
  onReleaseDraft?: (draft: ReleaseDraft) => void
  onRelease?: () => void
  onAssignTo?: (ownerId: string | null) => void
  onAssign?: () => void
  onExport?: (ids: readonly string[]) => void
  onDismissNotice?: () => void
  onStepUpSubmit?: (code: string) => void
  onStepUpCancel?: () => void
}

const NOBODY = '__nobody__'

/**
 * SCR-078 Quality › Holds (design quality.holds; Owner answer Q3: with this page, what is on hold is found here): the head
 * (one sentence, Updated · Live, ⋯ and Place hold), the most serious hold fact (holds whose quarantine move is not
 * confirmed), the tiles (each a saved view: Open, Overdue, Placed by the system, Waiting for my decision, Waiting
 * quarantine move), then the ONE list frame: select-all, shift range, x, Release N · Assign owner · Print tags · Export N
 * while rows are selected, inline Owner and Expected release (autosaved), the quarantine move in a popover, Show more,
 * the keys in the footer icon. A hold opens in its DetailModal (`?open=`, J / K). Fetches nothing: HoldsPage.tsx reads
 * and writes; the place dialog is the page's container; Decide in NCR opens B-W2a-68's New NCR.
 */
export function HoldsView({ model, actions, stepUp, panels }: { model: HoldsListModel; actions?: HoldsListActions; stepUp?: StepUpState; panels?: ReactNode }) {
  return (
    <HoldsMessages>
      <Holds model={model} actions={actions} stepUp={stepUp} panels={panels} />
    </HoldsMessages>
  )
}

function Holds({ model, actions, stepUp, panels }: { model: HoldsListModel; actions?: HoldsListActions; stepUp?: StepUpState; panels?: ReactNode }) {
  const t = useT('holds')
  const q = useT('quality')
  const lists = useT('lists')
  const locale = useLocale()
  const can = model.can
  const dialog = model.dialog ?? null
  const open = (next: HoldsDialog | null) => actions?.onDialog?.(next)
  const placeHeld = can.holdsPlace ? null : t('held.noPlace')

  // c: Place hold (the frame's own keys are / j k x ↵ ?; the same skip of fields, menus and dialogs).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.key !== 'c' || event.metaKey || event.ctrlKey || event.altKey || dialog || model.open || placeHeld) return
      if (target && (target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"]') || target.isContentEditable)) return
      event.preventDefault()
      actions?.onPlace?.()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // The cells reach the latest model and actions through a ref: a new actions object must not rebuild the columns.
  const latest = useRef({ model, actions })
  latest.current = { model, actions }
  const ncrHref = (id: string) => `${model.prefix}${recordAddress({ type: 'Nonconformance', id }, OFFICE_PAGES)}`

  const columns = useMemo<ColDef<Hold>[]>(() => {
    const me = model.me
    const prefix = model.prefix
    const HoldCell = ({ data }: ICellRendererParams<Hold>) => {
      if (!data) return null
      const codes = subjectCodes(data, 1)
      return (
        <span className="fw-q-cell">
          <Link
            className="fw-q-name"
            href={`${prefix}/quality/holds?open=${encodeURIComponent(data.id)}`}
            tabIndex={-1}
            onClick={(event) => {
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
              event.preventDefault()
              latest.current.actions?.onOpen?.(data.id)
            }}
          >
            {codes.codes[0]}
            {codes.more > 0 ? ` ${t('subject.more', { count: codes.more })}` : ''}
          </Link>
          <span className="fw-q-hint">{t('hold.kindSince', { kind: t(kindKey(data.subjectType)), date: formatDate(data.placedAt, { locale }) })}</span>
        </span>
      )
    }
    const SubjectCell = ({ data }: ICellRendererParams<Hold>) => {
      if (!data) return null
      const codes = subjectCodes(data, 3)
      return (
        <span className="fw-q-cell">
          <span>
            {data.subjects.length} {t(nounKey(data.subjectType), { count: data.subjects.length })}
          </span>
          <span className="fw-q-hint fw-q-code">
            {codes.codes.join(' · ')}
            {codes.more > 0 ? ` ${t('subject.more', { count: codes.more })}` : ''}
          </span>
        </span>
      )
    }
    const StatusCell = ({ data }: ICellRendererParams<Hold>) => (data ? <HoldPill hold={data} /> : null)
    const QuantityCell = ({ data }: ICellRendererParams<Hold>) => (data ? <span className="fw-q-num">{quantityWords(data.quantity, t) ?? '—'}</span> : null)
    const ReasonCell = ({ data }: ICellRendererParams<Hold>) =>
      data ? (
        <span className="fw-q-cell">
          <span>{reasonText(data, latest.current.model.reasons, locale)}</span>
          {data.reasonNote && <span className="fw-q-hint fw-hd-clip">{data.reasonNote}</span>}
        </span>
      ) : null
    const SourceCell = ({ data }: ICellRendererParams<Hold>) => {
      if (!data) return null
      const type = data.sourceType as keyof typeof SOURCE_RECORD | null
      const href = type && data.sourceId && SOURCE_RECORD[type] ? `${prefix}${recordAddress({ type: SOURCE_RECORD[type], id: data.sourceId }, OFFICE_PAGES)}` : null
      return href ? (
        <Link className="fw-q-link" href={href} tabIndex={-1}>
          {t(sourceKey(data))}
        </Link>
      ) : (
        <span>{t(sourceKey(data))}</span>
      )
    }
    const BlocksCell = ({ data }: ICellRendererParams<Hold>) => (data ? <span className="fw-q-hint fw-hd-clip">{t(blocksKey(data.subjectType))}</span> : null)
    const PlacedCell = ({ data }: ICellRendererParams<Hold>) =>
      data ? (
        <span className="fw-q-cell">
          <span>{t(placedByKey(data, me))}</span>
          <span className="fw-q-hint">{formatDateTime(data.placedAt, { locale })}</span>
        </span>
      ) : null
    const AgeCell = ({ data }: ICellRendererParams<Hold>) => (data ? <span className="fw-q-num">{t('age.days', { count: data.ageDays })}</span> : null)
    const OwnerCell = ({ data }: ICellRendererParams<Hold>) => {
      if (!data) return null
      const now = latest.current.model
      const words = ownerWords(data, me)
      const held = changeHeld(data, now.can)
      if (held) return <span className="fw-hd-ellipsis">{t(words.key, words.params)}</span>
      const people = now.people[data.siteId]
      const list = people?.value ?? []
      return (
        <span className="fw-q-cell-row">
          <Select
            size="sm"
            aria-label={t('cell.owner', { code: data.subjects[0]?.label ?? '—' })}
            value={data.ownerId ?? NOBODY}
            onFocus={() => people === undefined && latest.current.actions?.onNeedPeople?.(data.siteId)}
            onChange={(event) => latest.current.actions?.onOwner?.(data, event.target.value === NOBODY ? null : event.target.value)}
          >
            <option value={NOBODY}>{t('owner.nobody')}</option>
            {data.ownerId && !list.some((person) => person.id === data.ownerId) && <option value={data.ownerId}>{t(words.key, words.params)}</option>}
            {list.map((person) => (
              <option key={person.id} value={person.id}>
                {person.me ? t('owner.meNamed', { name: person.name }) : person.name}
              </option>
            ))}
          </Select>
          <SaveMark mark={now.cells[`${data.id}:owner`]} />
        </span>
      )
    }
    const ExpectedCell = ({ data }: ICellRendererParams<Hold>) => {
      if (!data) return null
      const now = latest.current.model
      const held = changeHeld(data, now.can)
      const overdue = data.overdue ? <span className="fw-q-hint fw-hd-danger">{t('expected.overdue')}</span> : null
      if (held)
        return (
          <span className="fw-q-cell">
            <span className="fw-q-num">{data.expectedReleaseOn ? formatDate(data.expectedReleaseOn, { locale }) : t('expected.none')}</span>
            {overdue}
          </span>
        )
      return (
        <span className="fw-q-cell">
          <span className="fw-q-cell-row">
            <Input
              size="sm"
              type="date"
              min={now.today}
              aria-label={t('cell.expected', { code: data.subjects[0]?.label ?? '—' })}
              defaultValue={data.expectedReleaseOn ?? ''}
              key={`${data.id}:${data.version}`}
              onBlur={(event) => {
                const next = event.target.value || null
                if (next !== data.expectedReleaseOn) latest.current.actions?.onExpected?.(data, next)
              }}
            />
            <SaveMark mark={now.cells[`${data.id}:expected`]} />
          </span>
          {overdue}
        </span>
      )
    }
    const QuarantineCell = ({ data }: ICellRendererParams<Hold>) => {
      if (!data) return null
      const word = t(quarantineKey(data))
      if (data.quarantine === 'NOT_NEEDED') return <span className="fw-q-hint">{word}</span>
      const forced = latest.current.model.moveOpen === data.id ? { open: true } : {}
      return (
        <DetailPopover trigger={<span className="fw-hd-move">{word}</span>} triggerLabel={t('move.trigger', { state: word })} label={t('move.title')} hoverDelay={0} {...forced}>
          <div className="fw-hd-pop">
            <strong>{t('move.title')}</strong>
            <dl className="fw-q-facts">
              <div className="fw-q-fact">
                <dt>{t('move.asked')}</dt>
                <dd>{formatDateTime(data.placedAt, { locale })}</dd>
              </div>
              <div className="fw-q-fact">
                <dt>{t('move.to')}</dt>
                <dd>{data.quarantineLocation ? `${data.quarantineLocation.code} · ${data.quarantineLocation.name}` : t('move.noPlace')}</dd>
              </div>
              <div className="fw-q-fact">
                <dt>{t('move.state')}</dt>
                <dd>{data.quarantine === 'MOVED' && data.quarantineMovedAt ? t('move.movedAt', { at: formatDateTime(data.quarantineMovedAt, { locale }) }) : t('move.notConfirmed')}</dd>
              </div>
            </dl>
            <p className="fw-q-hint">{t('move.later')}</p>
          </div>
        </DetailPopover>
      )
    }
    const SiteCell = ({ data }: ICellRendererParams<Hold>) => (data ? <span className="fw-q-code">{data.site?.code ?? '—'}</span> : null)
    const MoreCell = ({ data }: ICellRendererParams<Hold>) => {
      if (!data) return null
      const now = latest.current.model
      const release = releaseHeld(data, null, now.can)
      const trace = traceOf(prefix, data)
      const evidence = data.subjectType === 'GarmentSerial' && data.subjects[0]?.label ? `${prefix}/compliance/evidence/serial/${encodeURIComponent(data.subjects[0].label)}` : null
      const items: MenuItemDef[] = [
        { id: 'open', label: t('row.open'), onSelect: () => latest.current.actions?.onOpen?.(data.id) },
        { id: 'release', label: t('row.release'), disabled: release !== null, description: release ? t(release.key, release.params) : undefined, onSelect: () => latest.current.actions?.onDialog?.({ kind: 'release', ids: [data.id] }) },
        data.ncrId
          ? { id: 'ncr', label: t('row.openNcr'), href: ncrHref(data.ncrId) }
          : {
              id: 'ncr',
              label: t('row.raiseNcr'),
              disabled: !now.can.ncrRaise || data.status !== 'ACTIVE',
              description: !now.can.ncrRaise ? t('held.noNcr') : data.status !== 'ACTIVE' ? t('held.notActive') : t('row.raiseNcrHint'),
              onSelect: () => latest.current.actions?.onRaiseNcr?.(data),
            },
        { id: 'tag', label: t('row.tag'), href: tagAddress(prefix, [data.id]) ?? undefined, target: '_blank' },
        { id: 'trace', label: t('row.trace'), href: trace.href ?? undefined, target: '_blank', disabled: trace.href === null, description: trace.held ? t(trace.held) : undefined },
        evidence
          ? { id: 'evidence', label: t('row.evidence'), href: evidence, target: '_blank' }
          : { id: 'evidence', label: t('row.evidence'), disabled: data.subjectType !== 'WorkOrder', description: t(data.subjectType === 'WorkOrder' ? 'held.evidenceOpen' : 'held.evidenceKind'), onSelect: () => latest.current.actions?.onOpen?.(data.id) },
        { id: 'genealogy', label: t('row.genealogy'), disabled: true, description: t('held.later') },
        { id: 'copy', label: t('row.copy'), onSelect: () => void navigator.clipboard?.writeText(data.subjects.map((subject) => subject.label ?? '').filter(Boolean).join(' ')) },
      ]
      return <Menu align="right" label={<MoreHorizontal size={16} aria-hidden />} triggerProps={{ 'aria-label': t('row.menu', { code: data.subjects[0]?.label ?? '—' }) }} items={items} />
    }
    const column = (colId: string, header: string, cellRenderer: ColDef<Hold>['cellRenderer'], size: { flex?: number; minWidth?: number; width?: number; maxWidth?: number }): ColDef<Hold> => ({ colId, headerName: header, cellRenderer, sortable: false, ...size })
    return [
      column('hold', t('col.hold'), HoldCell, { flex: 1.5, minWidth: 190 }),
      column('status', t('col.status'), StatusCell, { flex: 0.9, minWidth: 160 }),
      column('subject', t('col.subject'), SubjectCell, { flex: 1.3, minWidth: 170 }),
      column('quantity', t('col.quantity'), QuantityCell, { flex: 0.9, minWidth: 120 }),
      column('reason', t('col.reason'), ReasonCell, { flex: 1.4, minWidth: 170 }),
      column('source', t('col.source'), SourceCell, { flex: 1, minWidth: 140 }),
      column('blocks', t('col.blocks'), BlocksCell, { flex: 1.5, minWidth: 190 }),
      column('placed', t('col.placed'), PlacedCell, { flex: 1.1, minWidth: 150 }),
      column('age', t('col.age'), AgeCell, { flex: 0.6, minWidth: 90 }),
      column('owner', t('col.owner'), OwnerCell, { flex: 1.2, minWidth: 180 }),
      column('expected', t('col.expected'), ExpectedCell, { flex: 1, minWidth: 170 }),
      column('quarantine', t('col.quarantine'), QuarantineCell, { flex: 0.9, minWidth: 140 }),
      column('site', t('col.site'), SiteCell, { flex: 0.5, minWidth: 80 }),
      { ...column('actions', t('col.actions'), MoreCell, { width: 72, minWidth: 72, maxWidth: 72 }), suppressHeaderMenuButton: true },
    ]
    // The cells close over the words and the person; the rest is read through `latest`.
  }, [t, locale, model.prefix, model.me, model.cells, model.people, model.reasons, model.moveOpen, model.can])

  if (!can.holdsView) return <NoAccess title={t('noAccess.title')} body={t('noAccess.body')} />

  const counts = model.counts.value
  const tiles = TILES.map((id) => {
    const active = model.view === id
    const count = counts ? counts[TILE_COUNT[id]] : null
    return {
      label: t(`tile.${id}`),
      value: model.counts.problem ? '—' : counts === null ? <Skeleton width={36} height={22} /> : countText(count),
      hint: model.counts.problem ? t('tile.unknown') : t(`tile.${id}Hint`),
      active,
      onClick: () => actions?.onView?.(active ? 'open' : id),
    }
  })

  const viewItems: MenuItemDef[] = [
    { id: 'heading', heading: true, label: t('list.rowsHeading') },
    ...VIEWS.map((view) => ({ id: view, label: t(`view.${view}`), checked: model.view === view, onSelect: () => actions?.onView?.(view) })),
    { id: 'board', label: t('view.board'), disabled: true, description: t('held.later') },
  ]
  const tools = (
    <>
      <Menu label={t('list.rows', { view: t(`view.${model.view}`) })} items={viewItems} />
      <span className="fw-q-chips" aria-label={t('list.activeFilters')}>
        {model.view !== 'open' && (
          <FilterChip pressed onClick={() => actions?.onView?.('open')} aria-label={t('list.removeFilter', { name: t(`view.${model.view}`) })}>
            {t(`view.${model.view}`)} <X size={12} aria-hidden />
          </FilterChip>
        )}
        {(model.subjectType || model.subjectId) && (
          <FilterChip pressed onClick={() => actions?.onClearScope?.()} aria-label={t('list.removeFilter', { name: t('list.scope') })}>
            {model.subjectId ? t('list.scopeRecord') : t(nounKey(model.subjectType!), { count: 2 })} <X size={12} aria-hidden />
          </FilterChip>
        )}
      </span>
    </>
  )

  const all = model.rows.value ?? []
  const rows = all.slice(0, model.limit)
  const picked = all.filter((hold) => model.selected.includes(hold.id))
  const releaseBulk = bulkReleaseHeld(picked, model.details, can)
  const assignBulk = bulkAssignHeld(picked, can)
  const count = model.selected.length
  const bulk = (
    <>
      <Button size="sm" variant="primary" heldReason={releaseBulk ? t(releaseBulk.key, releaseBulk.params) : null} onClick={() => open({ kind: 'release', ids: model.selected })} aria-label={t('bulk.release', { count })}>
        <ShieldCheck size={13} aria-hidden /> <SelectionLabel>{t('bulk.release', { count })}</SelectionLabel>
      </Button>
      <Button size="sm" heldReason={assignBulk ? t(assignBulk) : null} onClick={() => open({ kind: 'assign', ids: model.selected })} aria-label={t('bulk.assign', { count })}>
        <UserRound size={13} aria-hidden /> <SelectionLabel>{t('bulk.assign', { count })}</SelectionLabel>
      </Button>
      <Button size="sm" onClick={() => window.open(tagAddress(model.prefix, model.selected) ?? '', '_blank')} aria-label={t('bulk.tags', { count })}>
        <Printer size={13} aria-hidden /> <SelectionLabel>{t('bulk.tags', { count })}</SelectionLabel>
      </Button>
      <Button size="sm" onClick={() => actions?.onExport?.(model.selected)} aria-label={t('bulk.export', { count })}>
        <Download size={13} aria-hidden /> <SelectionLabel>{t('bulk.export', { count })}</SelectionLabel>
      </Button>
    </>
  )

  const state: ReactNode = model.rows.problem ? (
    <EmptyState
      title={t('list.failed')}
      description={q(model.rows.problem)}
      action={
        <Button size="sm" onClick={() => actions?.onRetry?.()}>
          {q('common.retry')}
        </Button>
      }
    />
  ) : model.rows.value !== null && all.length === 0 ? (
    model.view === 'open' && !model.subjectId && !model.subjectType ? (
      <EmptyState icon={<Hand size={24} aria-hidden />} title={t('list.empty.title')} description={t('list.empty.body')} action={<Button variant="primary" onClick={() => actions?.onPlace?.()} heldReason={placeHeld}>{t('list.place')}</Button>} />
    ) : (
      <EmptyState
        title={t('list.none')}
        description={t(`view.${model.view}Hint`)}
        action={
          <Button size="sm" onClick={() => (model.subjectId || model.subjectType ? actions?.onClearScope?.() : actions?.onView?.('open'))}>
            {t('list.clear')}
          </Button>
        }
      />
    )
  ) : undefined

  const ownKeys: ListKey[] = [
    { keys: ['c'], does: t('keys.place') },
    { keys: ['r'], does: t('keys.release') },
  ]
  const moreItems: MenuItemDef[] = [
    { id: 'tags', label: t('list.printTags'), disabled: rows.length === 0, description: rows.length === 0 ? t('held.noRows') : t('list.printTagsHint', { count: Math.min(rows.length, MAX) }), onSelect: () => window.open(tagAddress(model.prefix, rows.map((row) => row.id)) ?? '', '_blank') },
    { id: 'export', label: t('list.exportView'), disabled: rows.length === 0, description: rows.length === 0 ? t('held.noRows') : undefined, onSelect: () => actions?.onExport?.(rows.map((row) => row.id)) },
    { id: 'sep', separator: true },
    { id: 'keys', label: t('keys.title'), onSelect: () => open({ kind: 'shortcuts' }) },
  ]
  const openHold = model.open ?? null
  const ids = rows.map((row) => row.id)
  const releaseIds = dialog?.kind === 'release' ? dialog.ids : []
  const assignIds = dialog?.kind === 'assign' ? dialog.ids : []
  const waiting = counts?.waitingQuarantine ?? 0

  return (
    <div className="fw-q">
      <PageHead
        intro={t('list.intro')}
        status={<Freshness asOf={model.asOf} live={model.live} />}
        actions={
          <>
            <Menu align="right" label={<MoreHorizontal size={16} aria-hidden />} triggerProps={{ 'aria-label': t('list.more') }} items={moreItems} />
            <Button size="sm" variant="primary" onClick={() => actions?.onPlace?.()} heldReason={placeHeld} aria-keyshortcuts="c">
              <Hand size={14} aria-hidden /> {t('list.place')}
            </Button>
          </>
        }
      />
      <NoticeBanner notice={model.notice} namespace="holds" onDismiss={actions?.onDismissNotice} />
      {waiting > 0 && model.view !== 'quarantine' && (
        <Banner
          tone="warning"
          title={t('notice.quarantine', { count: waiting })}
          action={
            <Button size="sm" onClick={() => actions?.onView?.('quarantine')}>
              {t('notice.quarantineShow')}
            </Button>
          }
        >
          {t('notice.quarantineBody')}
        </Banner>
      )}
      <MetricStrip metrics={tiles} />
      <ListFrame<Hold>
        label={t('list.table')}
        rows={model.rows.problem ? [] : model.rows.value === null ? null : rows}
        rowId={(row) => row.id}
        columns={columns}
        count={model.rows.value === null ? t('list.countReading') : model.truncated ? t('list.countAtLeast', { count: all.length }) : t('list.count', { count: all.length })}
        tools={tools}
        selection={{ selected: model.selected, onChange: (next) => actions?.onSelect?.(next), actions: bulk }}
        updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
        more={model.rows.value !== null && all.length > model.limit ? { label: t('list.showMore'), onMore: () => actions?.onMore?.() } : model.truncated && model.limit >= all.length ? { label: t('list.showMore'), onMore: () => undefined, held: t('list.maxReached', { max: MAX }) } : null}
        keys={ownKeys}
        onHelp={() => open({ kind: 'shortcuts' })}
        onOpen={(row) => actions?.onOpen?.(row.id)}
        state={state}
        focusRow={model.focusRow}
      />

      {openHold && (
        <HoldDetailModal
          open={!dialog || dialog.kind === 'shortcuts' ? !dialog : false}
          id={openHold.id}
          detail={openHold.detail}
          tab={openHold.tab}
          model={model}
          panels={panels}
          nav={ids.includes(openHold.id) ? ids : null}
          actions={actions}
        />
      )}
      <ReleaseHoldDialog
        open={dialog?.kind === 'release'}
        holds={releaseEntries(releaseIds, all, model.details, openHold?.detail.value ?? null)}
        draft={model.releaseDraft ?? { note: '', statement: false }}
        me={model.me}
        busy={model.busy ?? false}
        problem={dialog?.kind === 'release' ? (model.dialogProblem ?? null) : null}
        lines={model.dialogLines ?? []}
        onDraft={(draft) => actions?.onReleaseDraft?.(draft)}
        onRelease={() => actions?.onRelease?.()}
        onClose={() => open(null)}
      />
      {dialog?.kind === 'assign' && <AssignDialog ids={assignIds} model={model} actions={actions} onClose={() => open(null)} />}
      <KeysModal open={dialog?.kind === 'shortcuts'} keys={listKeys(ownKeys, true).map((entry) => ({ keys: entry.keys, does: lists(entry.does) === entry.does ? entry.does : lists(entry.does) }))} onClose={() => open(null)} />
      {stepUp && <HoldsStepUp state={stepUp} onSubmit={(code) => actions?.onStepUpSubmit?.(code)} onCancel={() => actions?.onStepUpCancel?.()} />}
    </div>
  )
}

/** The holds a release dialog names, each with its checks when read (the list's row, else the open hold's record). */
function releaseEntries(ids: readonly string[], rows: readonly Hold[], details: Readonly<Record<string, HoldDetail>>, open: HoldDetail | null): { hold: Hold; detail: HoldDetail | null }[] {
  const out: { hold: Hold; detail: HoldDetail | null }[] = []
  for (const id of ids) {
    const hold = rows.find((row) => row.id === id) ?? (open?.hold.id === id ? open.hold : null)
    if (hold) out.push({ hold, detail: details[id] ?? (open?.hold.id === id ? open : null) })
  }
  return out
}

/** Assign owner for N holds of one site: one owner for all (or nobody), each hold named; one change each (no bulk route). */
function AssignDialog({ ids, model, actions, onClose }: { ids: readonly string[]; model: HoldsListModel; actions?: HoldsListActions; onClose: () => void }) {
  const t = useT('holds')
  const q = useT('quality')
  const holds = (model.rows.value ?? []).filter((hold) => ids.includes(hold.id))
  const siteId = holds[0]?.siteId ?? null
  const people = siteId ? model.people[siteId] : undefined
  useEffect(() => {
    if (siteId && people === undefined) actions?.onNeedPeople?.(siteId)
  }, [siteId, people, actions])
  const held = bulkAssignHeld(holds, model.can)
  const to = model.assignTo ?? null
  const heldText = held ? t(held) : model.busy ? q('common.working') : to === null ? t('assign.pickFirst') : null
  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      title={t('assign.title', { count: holds.length })}
      footer={
        <span className="fw-q-actions">
          <Button variant="secondary" onClick={onClose}>
            {q('common.cancel')}
          </Button>
          <Button variant="primary" heldReason={heldText} onClick={() => actions?.onAssign?.()}>
            <UserRound size={14} aria-hidden /> {t('assign.go', { count: holds.length })}
          </Button>
        </span>
      }
    >
      <div className="fw-q-stack">
        {model.dialogProblem && (
          <Banner tone="danger" title={t(model.dialogProblem)}>
            {model.dialogLines && model.dialogLines.length > 0 && (
              <ul className="fw-q-lines">
                {model.dialogLines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            )}
          </Banner>
        )}
        <Field label={t('assign.to')} hint={t('assign.toHint')}>
          {people === undefined || (people.value === null && !people.problem) ? (
            <Skeleton height={32} />
          ) : people.problem ? (
            <Banner tone="danger" title={q(people.problem)} />
          ) : (
            <Select value={to ?? ''} onChange={(event) => actions?.onAssignTo?.(event.target.value || null)}>
              <option value="">{t('assign.pick')}</option>
              {(people.value ?? []).map((person) => (
                <option key={person.id} value={person.id}>
                  {person.me ? t('owner.meNamed', { name: person.name }) : person.name}
                </option>
              ))}
              <option value={NOBODY}>{t('owner.nobody')}</option>
            </Select>
          )}
        </Field>
        <ul className="fw-q-lines" aria-label={t('assign.listLabel')}>
          {holds.map((hold) => {
            const words = ownerWords(hold, model.me)
            return (
              <li key={hold.id}>
                <strong>
                  {t(kindKey(hold.subjectType))} {hold.subjects[0]?.label ?? '—'}
                </strong>{' '}
                — {t('assign.now', { owner: t(words.key, words.params) })}
              </li>
            )
          })}
        </ul>
        <p className="fw-q-hint">{t('assign.oneEach')}</p>
      </div>
    </Modal>
  )
}

/** The keys dialog (`?`): this list's keys, then the frame's. */
function KeysModal({ open, keys, onClose }: { open: boolean; keys: ReadonlyArray<{ keys: readonly string[]; does: string }>; onClose: () => void }) {
  const t = useT('holds')
  const q = useT('quality')
  return (
    <Modal open={open} onClose={onClose} title={t('keys.title')} size="sm" footer={<Button onClick={onClose}>{q('common.close')}</Button>}>
      <dl className="fw-q-keymap">
        {keys.map((entry) => (
          <Fragment key={entry.does}>
            <dt>
              {entry.keys.map((key) => (
                <Kbd key={key}>{key}</Kbd>
              ))}
            </dt>
            <dd>{entry.does}</dd>
          </Fragment>
        ))}
        <dt>
          <Kbd>J</Kbd> <Kbd>K</Kbd>
        </dt>
        <dd>{t('keys.walk')}</dd>
      </dl>
    </Modal>
  )
}

