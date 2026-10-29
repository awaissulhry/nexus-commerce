'use client'

import { useEffect, useMemo, useRef } from 'react'
import Link from 'next/link'
import { Download, FlaskConical, MoreHorizontal, Search, X } from 'lucide-react'
import { Banner, EmptyState, Menu, MetricStrip, type MenuItemDef } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, FilterChip, Input, Skeleton, Tag } from '@nexus/ui/primitives'
import { formatDate } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { listKeys, type ListKey } from '../../../../list-frame/model'
import { isPageKey } from '../../../quality/_shared/hooks'
import { LIST_MAX, type Lot } from '../../../quality/_shared/lots'
import { dash, Freshness, NoAccess, NoticeBanner, PageHead } from '../../../quality/_shared/parts'
import { LEGAL_LIMIT, LOT_TILES, LOT_VIEWS, mgKg, type ListDialog, type LotsListModel, type LotTile, type LotView, type RuleDraft } from '../model'
import { PickLotDialog, RuleDialog } from './dialogs'
import { CrViMark, LabMessages, LabStepUp, LotStatusPill, ShortcutsDialog, useListWords } from './parts'

export interface LotsListActions {
  onQuery?: (query: string) => void
  onView?: (view: LotView) => void
  onClearAll?: () => void
  onMore?: () => void
  onRetry?: () => void
  onRetryRule?: () => void
  onShowUpdates?: () => void
  onSelect?: (ids: readonly string[]) => void
  onOpen?: (lot: Lot) => void
  onDialog?: (dialog: ListDialog | null) => void
  onPickQuery?: (query: string) => void
  onPick?: (lot: Lot) => void
  onRuleDraft?: (draft: RuleDraft) => void
  onSaveRule?: () => void
  onExport?: (lots: readonly Lot[]) => void
  onCopy?: (text: string) => void
  onDismissNotice?: () => void
  onStepUpSubmit?: (code: string) => void
  onStepUpCancel?: () => void
}

/** The lot record's address (a tab, an action to open there). */
export const lotHref = (prefix: string, lotId: string, query = ''): string => `${prefix}/compliance/tests/${encodeURIComponent(lotId)}${query ? `?${query}` : ''}`

/**
 * SCR-054 Tests & substances (design compliance.tests W1: ts-rule, ts-metrics, ts-lots): the Cr VI evidence rule said at
 * rest, the saved-filter tiles, and the lots with their chromium VI result against the limit on the ONE list frame
 * (Owner rule 2026-10-29): count, search, Rows ▾ and the chips — swapped for Export N while rows are selected — the grid
 * with the header select-all box and shift-click ranges, and the footer with Show more and the keys icon. A lot opens
 * its record (its results, documents and release). Fetches nothing: LotsPage.tsx reads and writes.
 */
export function LotsView({ model, actions }: { model: LotsListModel; actions?: LotsListActions }) {
  return (
    <LabMessages>
      <Lots model={model} actions={actions} />
    </LabMessages>
  )
}

function Lots({ model, actions }: { model: LotsListModel; actions?: LotsListActions }) {
  const t = useT('lab')
  const q = useT('quality')
  const locale = useLocale()
  const can = model.can
  const dialog = model.dialog ?? null
  const rows = useMemo(() => model.rows.value ?? [], [model.rows.value])
  const selectedRows = rows.filter((row) => model.selected.includes(row.id))
  const open = (next: ListDialog | null) => actions?.onDialog?.(next)
  const testHeld = can.lotsTest ? null : t('held.test')
  const lists = useListWords()

  // c: Record test result (the frame's keys are / j k x ↵ ?; the same rule skips fields, menus and dialogs).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'c' || dialog || !can.lotsTest || !isPageKey(event)) return
      event.preventDefault()
      actions?.onDialog?.({ kind: 'pick' })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [actions, can.lotsTest, dialog])

  // The cells reach the page's actions through a ref: a new actions object on each render must not rebuild the columns.
  const live = useRef({ actions })
  live.current = { actions }
  const columns = useMemo<ColDef<Lot>[]>(() => {
    const LotCell = ({ data }: ICellRendererParams<Lot>) =>
      data ? (
        <span className="fw-q-cell">
          <Link className="fw-q-name fw-q-code" href={lotHref(model.prefix, data.id)} tabIndex={-1}>
            {data.code}
          </Link>
          <span className="fw-q-hint">{data.receivedAt ? t('list.received', { date: formatDate(data.receivedAt, { locale }) }) : t('list.opening')}</span>
        </span>
      ) : null
    const MaterialCell = ({ data }: ICellRendererParams<Lot>) =>
      data ? (
        <span className="fw-q-cell">
          <span className="fw-q-cell-row">
            <span className="fw-q-code">{data.item.code}</span>
            {data.item.isPpeComponent && <Tag tone="info">{t('list.ppeComponent')}</Tag>}
          </span>
          <span className="fw-q-hint">{data.item.name}</span>
        </span>
      ) : null
    const CrViCell = ({ data }: ICellRendererParams<Lot>) => (data ? <CrViMark lot={data} /> : null)
    const StatusCell = ({ data }: ICellRendererParams<Lot>) =>
      data ? (
        <span className="fw-q-cell">
          <LotStatusPill status={data.qualityStatus} />
          {data.receipt?.status === 'REVERSED' && <span className="fw-q-hint">{t('list.receiptReversed')}</span>}
        </span>
      ) : null
    const HoldCell = ({ data }: ICellRendererParams<Lot>) => (data ? <span className="fw-q-hint">{dash(data.qualityStatus === 'QUARANTINE' ? data.hold : null)}</span> : null)
    const ActionsCell = ({ data }: ICellRendererParams<Lot>) =>
      data ? <Menu align="right" label={<MoreHorizontal size={16} aria-hidden />} triggerProps={{ 'aria-label': t('row.menu', { code: data.code }) }} items={rowItems(data)} /> : null
    const rowItems = (lot: Lot): MenuItemDef[] => {
      const href = lotHref(model.prefix, lot.id)
      const items: MenuItemDef[] = [
        { id: 'open', label: t('row.open'), href },
        { id: 'tab', label: t('row.openNewTab'), href, target: '_blank' },
      ]
      if (lot.crVi.required && lot.qualityStatus !== 'REJECTED' && lot.crVi.status !== 'FAIL')
        items.push(can.lotsTest ? { id: 'result', label: t('row.result'), href: lotHref(model.prefix, lot.id, 'tab=results&act=result') } : { id: 'result', label: t('row.result'), disabled: true, description: t('held.test') })
      if (lot.qualityStatus === 'QUARANTINE')
        items.push(can.lotsRelease ? { id: 'release', label: t('row.release'), href: lotHref(model.prefix, lot.id, 'tab=release&act=release') } : { id: 'release', label: t('row.release'), disabled: true, description: t('held.release') })
      if (lot.qualityStatus === 'QUARANTINE' || lot.qualityStatus === 'BLOCKED')
        items.push(can.lotsReject ? { id: 'reject', label: t('row.reject'), href: lotHref(model.prefix, lot.id, 'tab=release&act=reject') } : { id: 'reject', label: t('row.reject'), disabled: true, description: t('held.reject') })
      items.push({ id: 'copy', label: t('row.copy'), onSelect: () => live.current.actions?.onCopy?.(lot.code) })
      return items
    }
    const column = (colId: string, header: string, cellRenderer: ColDef<Lot>['cellRenderer'], size: { flex?: number; minWidth?: number; width?: number }): ColDef<Lot> => ({ colId, headerName: header, cellRenderer, sortable: false, ...size })
    return [
      column('lot', t('list.col.lot'), LotCell, { flex: 1.2, minWidth: 150 }),
      column('material', t('list.col.material'), MaterialCell, { flex: 2, minWidth: 200 }),
      column('crVi', t('list.col.crVi'), CrViCell, { flex: 1.6, minWidth: 190 }),
      { colId: 'evidence', headerName: t('list.col.evidence'), sortable: false, flex: 1.1, minWidth: 140, valueGetter: (params) => (params.data?.crVi.evidence ? t(`evidence.${params.data.crVi.evidence}`) : '—') },
      { colId: 'tested', headerName: t('list.col.tested'), sortable: false, flex: 0.8, minWidth: 110, valueGetter: (params) => (params.data?.crVi.testedOn ? formatDate(params.data.crVi.testedOn, { locale }) : '—') },
      column('status', t('list.col.status'), StatusCell, { flex: 1, minWidth: 130 }),
      column('hold', t('list.col.hold'), HoldCell, { flex: 1.4, minWidth: 160 }),
      { ...column('actions', t('list.col.actions'), ActionsCell, { width: 72, minWidth: 72 }), suppressHeaderMenuButton: true },
    ]
    // The cells close over the words and the rights: a change of language or rights rebuilds them.
  }, [t, locale, model.prefix, can.lotsTest, can.lotsRelease, can.lotsReject])

  if (!can.lotsView) return <NoAccess title={t('noAccess.title')} body={t('noAccess.body')} />

  const filtered = model.view !== 'all' || model.query.trim() !== ''

  // ---- the rule at rest ----
  const rule = model.rule
  const ruleBanner = rule.problem ? (
    <Banner
      tone="warning"
      title={t('rule.failed')}
      action={
        <Button size="sm" onClick={() => actions?.onRetryRule?.()}>
          {q('common.retry')}
        </Button>
      }
    />
  ) : rule.value ? (
    <Banner
      tone="info"
      title={t(`rule.title.${rule.value.crViEvidenceRule}`)}
      action={
        <Button size="sm" onClick={() => open({ kind: 'rule' })} heldReason={can.settingsManage ? null : t('held.rule')}>
          {t('rule.change')}
        </Button>
      }
    >
      {t('rule.limit', { limit: mgKg(rule.value.legalLimitMgKg ?? LEGAL_LIMIT, locale) })} {t(`rule.source.${rule.value.source}`)}
    </Banner>
  ) : (
    <Skeleton height={56} />
  )

  // ---- the tiles ----
  const tile = (id: LotTile) => {
    const entry = model.tiles[id]
    const active = model.view === id
    const count = entry.count
    return {
      label: t(`tile.${id}`),
      value: count === undefined ? <Skeleton width={36} height={22} /> : count === null ? '—' : entry.atLeast ? t('tile.atLeast', { count }) : String(count),
      hint: count === null ? t('tile.unknown') : t(`tile.${id}Hint`, { max: LIST_MAX }),
      active,
      onClick: () => actions?.onView?.(active ? 'all' : id),
    }
  }

  // ---- the toolbar's menus and chips ----
  const viewItems: MenuItemDef[] = [{ id: 'heading', heading: true, label: t('list.rowsHeading') }, ...LOT_VIEWS.map((view) => ({ id: view, label: t(`view.${view}`), checked: model.view === view, onSelect: () => actions?.onView?.(view) }))]
  const moreItems: MenuItemDef[] = [
    {
      id: 'export',
      label: t('list.exportView'),
      onSelect: () => actions?.onExport?.(rows),
      disabled: rows.length === 0,
      description: rows.length === 0 ? t('list.exportNothing') : t('list.exportViewHint', { count: rows.length }),
    },
    { id: 'rule', label: t('rule.change'), onSelect: () => open({ kind: 'rule' }), disabled: !can.settingsManage, description: can.settingsManage ? undefined : t('held.rule') },
    { id: 'sep', separator: true },
    { id: 'keys', label: t('keys.title'), onSelect: () => open({ kind: 'shortcuts' }) },
  ]
  const chip = (key: string, label: string, onRemove: () => void) => (
    <FilterChip key={key} pressed onClick={onRemove} aria-label={t('list.removeFilter', { name: label })}>
      {label} <X size={12} aria-hidden />
    </FilterChip>
  )
  const tools = (
    <>
      <Menu label={t('list.rows', { view: t(`view.${model.view}`) })} items={viewItems} />
      {filtered && (
        <span className="fw-q-chips" aria-label={t('list.activeFilters')}>
          {model.view !== 'all' && chip('view', t(`view.${model.view}`), () => actions?.onView?.('all'))}
          {model.query.trim() !== '' && chip('q', `“${model.query.trim()}”`, () => actions?.onQuery?.(''))}
          <Button size="sm" variant="quiet" onClick={() => actions?.onClearAll?.()}>
            {t('list.clearAll')}
          </Button>
        </span>
      )}
    </>
  )

  // ---- the bulk action: export says its reach (a lot is released one at a time, with its code typed) ----
  const bulkActions = (
    <Button size="sm" onClick={() => actions?.onExport?.(selectedRows)} aria-label={t('list.bulkExport', { count: selectedRows.length })}>
      <Download size={13} aria-hidden /> <SelectionLabel>{t('list.bulkExport', { count: selectedRows.length })}</SelectionLabel>
    </Button>
  )

  // ---- states in place of the grid (the toolbar stays) ----
  const state = model.rows.problem ? (
    <EmptyState
      title={t('list.failedTitle')}
      description={q(model.rows.problem)}
      action={
        <Button size="sm" onClick={() => actions?.onRetry?.()}>
          {q('common.retry')}
        </Button>
      }
    />
  ) : model.rows.value !== null && rows.length === 0 ? (
    filtered ? (
      <EmptyState
        title={t('list.noMatch')}
        action={
          <Button size="sm" onClick={() => actions?.onClearAll?.()}>
            {t('list.clearAll')}
          </Button>
        }
      />
    ) : (
      <EmptyState
        icon={<FlaskConical size={24} aria-hidden />}
        title={t('list.empty.title')}
        description={t('list.empty.body')}
        action={
          <Button variant="primary" onClick={() => open({ kind: 'pick' })} heldReason={testHeld}>
            {t('list.record')}
          </Button>
        }
      />
    )
  ) : undefined

  const ownKeys: ListKey[] = [{ keys: ['c'], does: t('keys.record') }]

  return (
    <div className="fw-q">
      <PageHead
        intro={t('list.intro')}
        status={<Freshness asOf={model.asOf} live={model.live} />}
        actions={
          <Button size="sm" variant="primary" onClick={() => open({ kind: 'pick' })} heldReason={testHeld}>
            {t('list.record')}
          </Button>
        }
      />
      {ruleBanner}
      <NoticeBanner notice={model.notice} namespace="lab" onDismiss={actions?.onDismissNotice} />
      <MetricStrip metrics={LOT_TILES.map(tile)} />

      <ListFrame<Lot>
        label={t('list.table')}
        rows={model.rows.problem ? [] : model.rows.value}
        rowId={(row) => row.id}
        columns={columns}
        count={t('list.count', { count: rows.length })}
        search={
          <Input
            size="sm"
            type="search"
            leadingIcon={<Search size={14} aria-hidden />}
            aria-label={t('list.search')}
            placeholder={t('list.search')}
            value={model.query}
            onChange={(event) => actions?.onQuery?.(event.target.value)}
          />
        }
        tools={tools}
        right={<Menu align="right" label={<MoreHorizontal size={16} aria-hidden />} triggerProps={{ 'aria-label': t('list.more') }} items={moreItems} />}
        selection={{ selected: model.selected, onChange: (ids) => actions?.onSelect?.(ids), actions: bulkActions }}
        updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
        more={
          model.more
            ? { label: t('list.showMore', { count: Math.min(50, LIST_MAX - model.limit) }), onMore: () => actions?.onMore?.(), held: model.loadingMore ? q('common.loading') : null }
            : model.capped
              ? { label: t('list.showMore', { count: 50 }), onMore: () => undefined, held: t('held.listMax', { max: LIST_MAX }) }
              : null
        }
        keys={ownKeys}
        onHelp={() => open({ kind: 'shortcuts' })}
        onOpen={(row) => actions?.onOpen?.(row)}
        state={state}
        focusRow={model.focusRow}
      />

      <PickLotDialog
        open={dialog?.kind === 'pick'}
        rows={model.pick ?? { value: null, problem: null }}
        query={model.pickQuery ?? ''}
        prefix={model.prefix}
        onQuery={(text) => actions?.onPickQuery?.(text)}
        onPick={(lot) => actions?.onPick?.(lot)}
        onClose={() => open(null)}
      />
      <RuleDialog
        open={dialog?.kind === 'rule'}
        settings={model.rule.value}
        draft={model.ruleDraft ?? null}
        busy={!!model.busy}
        problem={model.dialogProblem ?? null}
        onDraft={(draft) => actions?.onRuleDraft?.(draft)}
        onSave={() => actions?.onSaveRule?.()}
        onClose={() => open(null)}
      />
      <LabStepUp state={model.stepUp} onSubmit={actions?.onStepUpSubmit} onCancel={actions?.onStepUpCancel} />
      <ShortcutsDialog open={dialog?.kind === 'shortcuts'} onClose={() => open(null)} keys={listKeys(ownKeys, true).map((entry) => ({ keys: entry.keys, does: lists(entry.does) }))} />
    </div>
  )
}
