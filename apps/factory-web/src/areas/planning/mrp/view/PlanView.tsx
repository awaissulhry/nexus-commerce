'use client'

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { AlertTriangle, Ban, Download, FilePlus2, MoreHorizontal, Play, RotateCcw, Search, ShieldOff } from 'lucide-react'
import { Banner, Card, EmptyState, KeyValue, Menu, MetricStrip } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, InfoTip, Input, Pill, Select, Skeleton, Spinner } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../list-frame/ListFrame'
import type { ListKey } from '../../../../list-frame/model'
import { formatDate, formatDateTime, formatTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { dayAt, money, quantity } from '../../../_shared/buying/model'
import type { PlanLine } from '../api'
import { decisionPhrase, draftHeld, draftReach, heldByReason, heldReason, PLAN_VIEWS, planState, runSeconds, TILES, visibleLines, type PlanActions, type PlanModel, type PlanView as PlanViewName } from '../model'
import { PlanDialogs } from './PlanDialogs'
import { WhyModal } from './WhyModal'
import '../../../_shared/buying/buying.css'

export type { PlanActions, PlanModel } from '../model'

/**
 * SCR-055 — What to buy & make (Planning; design planning.mrp, 00 §2.1 list frame): the band (the plan's state and
 * time, Run plan now, Draft POs for every open Buy line), the run strip (which plan, how fresh, a failed or running
 * attempt), the run's warnings, the stock that exists but may not be used, the tiles (saved views), and every line on
 * the shared list frame: the netting said as words from the numbers ("Need 420 − usable 120 − on order 100 = short
 * 200 ft²"), the order-by day, the suggestion in the supplier's unit (≈ hides for leather), the supplier, the expected
 * value (cost grain only: the column is not drawn without it), the orders behind it and the decision. One click drafts
 * a line into the supplier's open draft PO (with Undo); a selection drafts many, sets them aside or puts them back.
 * Enter (or the Why cell) opens "Why this number" (`?line=`). Nothing is ever ordered by itself.
 */
export function PlanView({ model, actions }: { model: PlanModel; actions?: PlanActions }) {
  return (
    <WithMessages namespaces={['buying', 'lists']}>
      <PlanScreen model={model} actions={actions} />
    </WithMessages>
  )
}

function PlanScreen({ model, actions }: { model: PlanModel; actions?: PlanActions }) {
  const t = useT('buying')
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const [query, setQuery] = useState(model.q)
  useEffect(() => setQuery(model.q), [model.q])
  const typed = useRef(false)
  const latest = useRef(actions)
  latest.current = actions
  useEffect(() => {
    if (!typed.current) return
    const timer = setTimeout(() => latest.current?.onSearch?.(query), 250)
    return () => clearTimeout(timer)
  }, [query])
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  useEffect(() => setSelected(model.selected ?? []), [model.selected])

  const plan = model.plan.status === 'ready' ? model.plan.value : null
  const lines = useMemo(() => (plan ? visibleLines(plan.lines, model.view, model.q) : null), [plan, model.view, model.q])
  const linesKey = lines?.map((line) => line.id).join(',') ?? ''
  useEffect(() => setSelected((current) => current.filter((id) => linesKey.includes(id))), [linesKey])
  const picked = (lines ?? []).filter((line) => selected.includes(line.id))
  const pickedReach = draftReach(picked)
  const allReach = draftReach(plan?.lines ?? [])
  const state = planState(plan)

  // b drafts the focused or selected Buy lines, i sets them aside, Shift R runs the plan (never while typing or in a dialog).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.metaKey || event.ctrlKey || event.altKey || model.dialog || model.why) return
      if (target && (target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"]') || target.isContentEditable)) return
      if (event.key === 'R' && event.shiftKey && model.can.planRun && !model.running) {
        event.preventDefault()
        actions?.onRun?.()
      } else if (event.key === 'b' && picked.length > 0 && pickedReach.lines > 0 && model.can.poManage) {
        event.preventDefault()
        actions?.onDraftMany?.(picked.map((line) => line.id))
      } else if (event.key === 'i' && picked.length > 0 && model.can.planDecide) {
        event.preventDefault()
        actions?.onSetAside?.(picked.filter((line) => line.decision === 'OPEN').map((line) => line.id))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (!model.can.planView) {
    return (
      <div className="fw-by">
        <Card padded>
          <EmptyState icon={<ShieldOff size={24} aria-hidden />} title={t('plan.noAccess.title')} description={t('plan.noAccess.body')} />
        </Card>
      </div>
    )
  }

  const sites = model.sites.status === 'ready' ? model.sites.value : []
  const site = sites.find((entry) => entry.id === model.siteId) ?? null
  const ownKeys: ListKey[] = [
    { keys: ['b'], does: t('plan.keys.draft') },
    { keys: ['i'], does: t('plan.keys.setAside') },
    { keys: ['⇧', 'R'], does: t('plan.keys.run') },
  ]

  const runHeld = !model.can.planRun ? t('held.noRun') : model.running || state === 'running' ? t('held.running') : !model.siteId ? t('held.noSite') : null
  const draftAllHeld = !model.can.poManage ? t('held.noPurchasing') : allReach.lines === 0 ? t('held.nothingToBuy') : null

  const columns = buildColumns()
  function buildColumns(): ColDef<PlanLine>[] {
    const MaterialCell = ({ data }: ICellRendererParams<PlanLine>) =>
      data ? (
        <span className="fw-by-cell">
          <span className="fw-by-ellipsis">
            {data.item.code} · {data.item.name}
          </span>
          <span className="fw-by-cell-sub">
            {[t(`plan.action.${data.action}`), data.colour ? `${data.colour.code} ${data.colour.name}` : null, data.item.requiresCrViTest ? t('plan.crVi') : null].filter(Boolean).join(' · ')}
          </span>
        </span>
      ) : null
    const numbers = (line: PlanLine) => ({ gross: quantity(line.grossQuantity, locale), usable: quantity(line.usableStock, locale), onOrder: quantity(line.onOrder, locale), net: quantity(line.netQuantity, locale), unit: t(`uom.${line.uom}`) })
    const WhyCell = ({ data }: ICellRendererParams<PlanLine>) => {
      if (!data) return null
      const held = Number(data.heldStock) > 0
      return (
        <span className="fw-by-cell">
          <Button
            size="sm"
            variant="link"
            onClick={() => actions?.onWhy?.(data.id)}
            aria-label={`${t('plan.why', numbers(data))} — ${t('plan.whyOpen', { material: data.item.code })}`}
            title={t('plan.why', numbers(data))}
          >
            <span className="fw-by-ellipsis fw-by-num">{t('plan.whyShort', numbers(data))}</span>
          </Button>
          {held && (
            <span className="fw-by-inline fw-by-cell-sub">
              <span className="fw-by-warning">{t('plan.heldShort', { quantity: quantity(data.heldStock, locale), unit: t(`uom.${data.uom}`) })}</span>
              <InfoTip tip={t('plan.heldTip')} />
            </span>
          )}
        </span>
      )
    }
    const DatesCell = ({ data }: ICellRendererParams<PlanLine>) =>
      data ? (
        <span className="fw-by-cell">
          <span>{formatDate(dayAt(data.needDate), place)}</span>
          <span className={data.orderBy?.passed && data.decision === 'OPEN' ? 'fw-by-cell-sub fw-by-danger' : 'fw-by-cell-sub'}>
            {data.orderBy ? (data.orderBy.leadTimeDays === null ? t('plan.orderByNoLead', { date: formatDate(dayAt(data.orderBy.date), place) }) : t('plan.orderBy', { date: formatDate(dayAt(data.orderBy.date), place), count: data.orderBy.leadTimeDays })) : t('plan.made')}
          </span>
        </span>
      ) : null
    const BuyCell = ({ data }: ICellRendererParams<PlanLine>) =>
      data ? (
        <span className="fw-by-cell">
          <span className="fw-by-num">
            {quantity(data.suggestedQuantity, locale)} {t(`uom.${data.suggestedUom}`)}
          </span>
          <span className="fw-by-cell-sub">
            {data.estimatedHides !== null && data.suggestedUom !== 'HIDE' ? t('plan.hides', { count: data.estimatedHides }) : model.can.cost && data.expectedAmount != null ? money(data.expectedAmount, data.currency, locale) : `${quantity(data.suggestedBaseQuantity, locale)} ${t(`uom.${data.uom}`)}`}
          </span>
        </span>
      ) : null
    const SupplierCell = ({ data }: ICellRendererParams<PlanLine>) =>
      data ? (
        <span className="fw-by-cell">
          {data.supplier ? <span className="fw-by-ellipsis">{data.supplier.name}</span> : <span className="fw-by-warning fw-by-ellipsis">{t(data.action === 'BUY' ? 'plan.noSupplier' : 'plan.made')}</span>}
          <span className="fw-by-cell-sub">
            {data.orders.length > 2
              ? t('plan.forOrdersMore', { orders: data.orders.slice(0, 2).map((order) => order.number).join(', '), count: data.orders.length - 2 })
              : data.orders.length > 0
                ? t('plan.forOrders', { orders: data.orders.map((order) => order.number).join(', ') })
                : ''}
          </span>
        </span>
      ) : null
    const ValueCell = ({ data }: ICellRendererParams<PlanLine>) => (data ? <span className="fw-by-num">{money(data.expectedAmount ?? null, data.currency, locale)}</span> : null)
    /** The decision, or for an open Buy line the one-click Draft PO (held with its reason). */
    const DecisionCell = ({ data }: ICellRendererParams<PlanLine>) => {
      if (!data) return null
      if (data.action === 'BUY' && data.decision === 'OPEN' && Number(data.netQuantity) > 0) {
        const held = draftHeld(data, model.can)
        const busy = model.drafting.includes(data.id)
        return (
          <Button size="sm" variant={held ? 'quiet' : 'secondary'} heldReason={held ? t(held) : busy ? t('held.busy') : null} onClick={() => actions?.onDraftOne?.(data.id)} aria-label={t('plan.draftOne', { material: data.item.code })}>
            {busy ? <Spinner size={12} /> : <FilePlus2 size={13} aria-hidden />} {t('plan.draftShort')}
          </Button>
        )
      }
      const words = decisionPhrase(data)
      const text = t(words.key, words.params ? { ...words.params, status: words.params.status ? t(String(words.params.status)) : '' } : undefined)
      if (data.purchaseOrder) {
        return (
          <Link className="fw-by-link fw-by-ellipsis" href={`${model.prefix}/purchasing/orders/${data.purchaseOrder.id}`}>
            {text}
          </Link>
        )
      }
      return <span className={data.decision === 'IGNORED' ? 'fw-by-cell-sub fw-by-ellipsis' : 'fw-by-ellipsis'}>{text}</span>
    }
    const MoreCell = ({ data }: ICellRendererParams<PlanLine>) =>
      data ? (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('plan.rowMenu', { material: data.item.code }) }}
          items={[
            { id: 'why', label: t('plan.explain'), onSelect: () => actions?.onWhy?.(data.id) },
            ...(data.decision === 'OPEN' ? [{ id: 'aside', label: t('plan.setAside'), onSelect: () => actions?.onSetAside?.([data.id]), disabled: !model.can.planDecide }] : []),
            ...(data.decision === 'IGNORED' ? [{ id: 'back', label: t('plan.putBack'), onSelect: () => actions?.onReopen?.([data.id]), disabled: !model.can.planDecide }] : []),
            ...(data.purchaseOrder ? [{ id: 'po', label: t('plan.openOrder', { number: data.purchaseOrder.number }), href: `${model.prefix}/purchasing/orders/${data.purchaseOrder.id}` }] : []),
            ...(data.supplier ? [{ id: 'supplier', label: t('plan.openSupplier'), href: `${model.prefix}/purchasing/suppliers/${data.supplier.id}` }] : []),
          ]}
        />
      ) : null
    return [
      { colId: 'material', headerName: t('plan.col.material'), minWidth: 220, flex: 1.5, cellRenderer: MaterialCell },
      { colId: 'why', headerName: t('plan.col.why'), minWidth: 260, flex: 1.8, cellRenderer: WhyCell },
      { colId: 'dates', headerName: t('plan.col.dates'), minWidth: 200, flex: 1.2, cellRenderer: DatesCell },
      { colId: 'buy', headerName: t('plan.col.buy'), minWidth: 120, flex: 0.8, cellRenderer: BuyCell },
      { colId: 'supplier', headerName: t('plan.col.supplier'), minWidth: 190, flex: 1.3, cellRenderer: SupplierCell },
      ...(model.can.cost ? [{ colId: 'value', headerName: t('plan.col.value'), minWidth: 104, flex: 0.6, type: 'rightAligned', cellRenderer: ValueCell } satisfies ColDef<PlanLine>] : []),
      { colId: 'decision', headerName: t('plan.col.decision'), minWidth: 170, flex: 1.1, cellRenderer: DecisionCell },
      { colId: 'more', headerName: t('plan.col.more'), minWidth: 64, maxWidth: 64, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
  }

  const tileView = TILES.find((tile) => tile.view === model.view)?.view ?? null
  const failed = plan?.latestAttempt?.status === 'FAILED' ? plan.latestAttempt : null
  const runningAttempt = plan?.latestAttempt?.status === 'RUNNING' ? plan.latestAttempt : null
  const heldReasons = model.held ? heldByReason(model.held) : []

  let listState: ReactNode = undefined
  if (model.plan.status === 'error') {
    listState = <EmptyState title={t('plan.failed')} description={t(model.plan.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('common.retry')}</Button>} />
  } else if (plan && !plan.run) {
    listState = (
      <EmptyState
        title={t('plan.empty.noPlan.title')}
        description={t('plan.empty.noPlan.body')}
        action={
          <Button size="sm" variant="primary" heldReason={runHeld} onClick={() => actions?.onRun?.()}>
            <Play size={13} aria-hidden /> {t('plan.run')}
          </Button>
        }
      />
    )
  } else if (plan && lines && lines.length === 0) {
    listState =
      model.q.trim() !== '' || (model.view !== 'open' && model.view !== 'all') ? (
        <EmptyState
          title={t('plan.empty.noMatch.title')}
          description={t('plan.empty.noMatch.body')}
          action={
            <Button
              size="sm"
              onClick={() => {
                setQuery('')
                actions?.onSearch?.('')
                actions?.onView?.('open')
              }}
            >
              {t('common.clearFilters')}
            </Button>
          }
        />
      ) : (
        <EmptyState title={t('plan.empty.covered.title')} description={t('plan.empty.covered.body')} action={<Button size="sm" onClick={() => actions?.onHistory?.()}>{t('plan.history')}</Button>} />
      )
  }

  return (
    <div className="fw-by">
      <div className="fw-by-head">
        <span className="fw-by-status" role="status">
          {plan?.run ? (
            <Pill tone={state === 'failed' ? 'danger' : state === 'running' ? 'info' : 'success'}>{t(`plan.state.${state}`)}</Pill>
          ) : model.plan.status === 'loading' ? (
            <Skeleton width={80} height={20} />
          ) : (
            <Pill tone="neutral">{t('plan.state.none')}</Pill>
          )}
          {plan?.run ? t('plan.asOf', { time: formatDateTime(plan.run.finishedAt ?? plan.run.startedAt, place), trigger: t(`plan.trigger.${plan.run.trigger}`) }) : null}
          {' · '}
          {t(`live.${model.live}`)}
        </span>
        <span className="fw-by-actions">
          {sites.length > 1 && (
            <Select size="sm" aria-label={t('plan.site')} value={model.siteId ?? ''} onChange={(event) => actions?.onSite?.(event.target.value)}>
              {sites.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.code} · {entry.name}
                </option>
              ))}
            </Select>
          )}
          {sites.length === 1 && site && <span className="fw-by-hint">{t('plan.siteOne', { site: `${site.code} · ${site.name}` })}</span>}
          <Button size="sm" heldReason={runHeld} onClick={() => actions?.onRun?.()} aria-keyshortcuts="Shift+R">
            {model.running ? <Spinner size={12} /> : <Play size={13} aria-hidden />} {model.running ? t('plan.running') : t('plan.run')}
          </Button>
          <Button size="sm" variant="primary" heldReason={draftAllHeld} onClick={() => actions?.onDraftMany?.((plan?.lines ?? []).map((line) => line.id))}>
            <FilePlus2 size={13} aria-hidden /> {t('plan.draftAll', { lines: t('plan.count', { count: allReach.lines }), suppliers: t('plan.suppliers', { count: allReach.suppliers }) })}
          </Button>
          <Menu
            label={<MoreHorizontal size={16} aria-hidden />}
            align="right"
            triggerProps={{ 'aria-label': t('plan.more') }}
            items={[
              { id: 'history', label: t('plan.history'), onSelect: () => actions?.onHistory?.() },
              { id: 'explainer', label: t('plan.explainer.menu'), onSelect: () => actions?.onExplainer?.() },
              { id: 'export', label: t('plan.exportView'), onSelect: () => actions?.onExport?.((lines ?? []).map((line) => line.id)), disabled: !lines || lines.length === 0 },
              { id: 'keys', label: t('common.shortcuts'), onSelect: () => actions?.onKeys?.() },
            ]}
          />
        </span>
      </div>

      {model.sites.status === 'error' && <Banner tone="danger" title={t('plan.sitesFailed')} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('common.retry')}</Button>} />}
      {model.sites.status === 'ready' && sites.length === 0 && <Banner tone="info" title={t('plan.noSites')} />}

      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={t(model.notice.words.key, model.notice.words.params)}
          action={
            <span className="fw-by-inline">
              {model.notice.open && (
                <Button size="sm" asChild>
                  <Link href={model.notice.open.href}>{model.notice.open.label}</Link>
                </Button>
              )}
              {model.notice.undo && (
                <Button size="sm" onClick={() => actions?.onUndo?.()}>
                  <RotateCcw size={13} aria-hidden /> {t('common.undo')}
                </Button>
              )}
              <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
                {t('common.dismiss')}
              </Button>
            </span>
          }
        />
      )}

      {/* The run strip: which plan, how fresh, and a newer attempt that runs or failed. */}
      <Card padded>
        <div className="fw-by-stack">
          <div className="fw-by-card-head">
            <h2 className="fw-by-h2">{t('plan.strip.title')}</h2>
            {plan?.run && <span className="fw-by-hint">{t('plan.strip.explain')}</span>}
          </div>
          {model.plan.status === 'loading' ? (
            <div className="fw-by-stack" aria-busy="true">
              <Skeleton height={18} />
              <Skeleton height={18} width="60%" />
            </div>
          ) : plan?.run ? (
            <KeyValue
              dense
              columns={3}
              labelCase="sentence"
              items={[
                { label: t('plan.strip.trigger'), value: t(`plan.trigger.${plan.run.trigger}`) },
                { label: t('plan.strip.started'), value: formatDateTime(plan.run.startedAt, place) },
                { label: t('plan.strip.took'), value: runSeconds(plan.run) === null ? '—' : t('plan.strip.seconds', { count: runSeconds(plan.run)! }) },
                { label: t('plan.strip.orderLines'), value: String(plan.run.orderLines) },
                { label: t('plan.strip.lines'), value: t('plan.strip.linesShort', { lines: plan.run.requirements, short: plan.run.short }) },
                { label: t('plan.strip.site'), value: site ? `${site.code} · ${site.name}` : '—' },
              ]}
            />
          ) : model.plan.status === 'ready' ? (
            <p className="fw-by-hint">{t('plan.strip.none')}</p>
          ) : null}
          {runningAttempt && <Banner tone="info" title={t('plan.strip.runningNow', { time: formatTime(runningAttempt.startedAt, place) })} />}
          {failed && <Banner tone="danger" title={t('plan.strip.failedAt', { time: formatTime(failed.startedAt, place) })}>{plan?.run ? t('plan.strip.stillShowing', { time: formatTime(plan.run.finishedAt ?? plan.run.startedAt, place) }) : t('plan.strip.noneShowing')}</Banner>}
        </div>
      </Card>

      {plan?.run && plan.run.warnings.length > 0 && (
        <Banner tone="warning" title={t('plan.warnings.title', { count: plan.run.warnings.length })}>
          <ul className="fw-by-list">
            {[...new Set(plan.run.warnings.map((warning) => warning.code))].map((code) => (
              <li key={code}>{t(`plan.warning.${code}`, { count: plan.run!.warnings.filter((warning) => warning.code === code).length })}</li>
            ))}
          </ul>
        </Banner>
      )}

      {plan && plan.summary.shortWithHeldStock > 0 && (
        <Banner
          tone="warning"
          title={t('plan.heldNotice', { count: plan.summary.shortWithHeldStock })}
          action={
            model.view !== 'held' ? (
              <Button size="sm" onClick={() => actions?.onView?.('held')}>
                <AlertTriangle size={13} aria-hidden /> {t('plan.heldShow')}
              </Button>
            ) : undefined
          }
        >
          {heldReasons.length > 0 ? heldReasons.map((entry) => t(`plan.heldReason.${entry.reason}`, { count: entry.lots })).join(' · ') : null}
        </Banner>
      )}

      <MetricStrip
        metrics={TILES.map((tile) => ({
          label: t(`plan.tile.${tile.id}`),
          value: plan?.run ? String(tile.count(plan.summary)) : '—',
          onClick: () => actions?.onView?.(model.view === tile.view ? 'open' : tile.view),
          active: tileView === tile.view,
        }))}
      />

      <ListFrame<PlanLine>
        label={t('plan.tableLabel')}
        rows={listState ? [] : (lines ?? null)}
        rowId={(line) => line.id}
        columns={columns}
        count={lines ? t('plan.count', { count: lines.length }) : '—'}
        search={
          <Input
            size="sm"
            type="search"
            leadingIcon={<Search size={13} aria-hidden />}
            aria-label={t('plan.search')}
            placeholder={t('plan.search')}
            value={query}
            onChange={(event) => {
              typed.current = true
              setQuery(event.target.value)
            }}
          />
        }
        tools={
          <Select size="sm" aria-label={t('plan.viewLabel')} value={model.view} onChange={(event) => actions?.onView?.(event.target.value as PlanViewName)}>
            {PLAN_VIEWS.map((view) => (
              <option key={view} value={view}>
                {t(`plan.view.${view}`)}
              </option>
            ))}
          </Select>
        }
        selection={{
          selected,
          onChange: setSelected,
          actions: (
            <>
              <Button
                size="sm"
                variant="primary"
                aria-label={t('plan.bulk.draft', { lines: t('plan.count', { count: pickedReach.lines }), suppliers: t('plan.suppliers', { count: pickedReach.suppliers }) })}
                heldReason={!model.can.poManage ? t('held.noPurchasing') : pickedReach.lines === 0 ? t('held.noBuyLine') : null}
                onClick={() => actions?.onDraftMany?.(picked.map((line) => line.id))}
              >
                <FilePlus2 size={13} aria-hidden /> <SelectionLabel>{t('plan.bulk.draft', { lines: t('plan.count', { count: pickedReach.lines }), suppliers: t('plan.suppliers', { count: pickedReach.suppliers }) })}</SelectionLabel>
              </Button>
              <Button
                size="sm"
                aria-label={t('plan.bulk.setAside', { count: picked.filter((line) => line.decision === 'OPEN').length })}
                heldReason={!model.can.planDecide ? t('held.noDecide') : picked.every((line) => line.decision !== 'OPEN') ? t('held.noneOpen') : null}
                onClick={() => actions?.onSetAside?.(picked.filter((line) => line.decision === 'OPEN').map((line) => line.id))}
              >
                <Ban size={13} aria-hidden /> <SelectionLabel>{t('plan.bulk.setAside', { count: picked.filter((line) => line.decision === 'OPEN').length })}</SelectionLabel>
              </Button>
              {picked.some((line) => line.decision === 'IGNORED') && (
                <Button
                  size="sm"
                  aria-label={t('plan.bulk.putBack', { count: picked.filter((line) => line.decision === 'IGNORED').length })}
                  heldReason={!model.can.planDecide ? t('held.noDecide') : null}
                  onClick={() => actions?.onReopen?.(picked.filter((line) => line.decision === 'IGNORED').map((line) => line.id))}
                >
                  <RotateCcw size={13} aria-hidden /> <SelectionLabel>{t('plan.bulk.putBack', { count: picked.filter((line) => line.decision === 'IGNORED').length })}</SelectionLabel>
                </Button>
              )}
              <Button size="sm" aria-label={t('plan.bulk.export', { count: picked.length })} onClick={() => actions?.onExport?.(picked.map((line) => line.id))}>
                <Download size={13} aria-hidden /> <SelectionLabel>{t('plan.bulk.export', { count: picked.length })}</SelectionLabel>
              </Button>
            </>
          ),
        }}
        isRowSelectable={(line) => {
          const reason = heldReason(line, model.can)
          return reason ? t(reason) : null
        }}
        updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
        keys={ownKeys}
        onHelp={() => actions?.onKeys?.()}
        onOpen={(line) => actions?.onWhy?.(line.id)}
        state={listState}
        focusRow={model.focusRow}
        keysOpen={model.keysOpen}
      />
      {model.view !== 'open' && <p className="fw-by-hint">{t('plan.viewing', { view: t(`plan.view.${model.view}`) })}</p>}

      <PlanDialogs model={model} actions={actions} ownKeys={ownKeys} />
      {model.why && <WhyModal model={model} actions={actions} order={(lines ?? []).map((line) => line.id)} />}
    </div>
  )
}
