'use client'

import { useMemo, useRef } from 'react'
import { Copy, Filter, MoreHorizontal } from 'lucide-react'
import { Banner, Card, Menu, type MenuItemDef } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { sizeColumns } from '@nexus/ui/grid/size-columns/index'
import { Button, Skeleton, Spinner, Tag } from '@nexus/ui/primitives'
import { CellSaveMark, useDsWords } from '../../../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../../../lib/i18n/format'
import { INTL_LOCALE } from '../../../../../../lib/i18n/locales'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../../record-panels/i18n'
import { ListFrame } from '../../../../../../list-frame/ListFrame'
import type { ListKey } from '../../../../../../list-frame/model'
import { minutesText } from '../../../model'
import { copyLibraryHeld, depthHeld, extraOf, NO_DEPTH, rowsOf, runWords, type CellMark, type DepthRow, type RoutingDepthActions, type RoutingDepthModel } from '../model'
import { DepthDialogs } from './DepthDialogs'
import '../routing-depth.css'

/**
 * SCR-043 — the Routing tab in depth (B-W2b-235; design products.styles › Operations (routing): "Quality checkpoint (W2b)",
 * "Setup / run / wait / move (W2b)", "Only for sizes, colours or options (W2b)", "Extra minutes for big sizes or options
 * (W2b)"; PRD-114, PRD-118, PRD-119, PRD-126, PRD-128): one row per step on the shared list frame — its run per garment and
 * where it comes from, set-up · wait · move per work order, the extra minutes per size (SizeColumns over the style's range:
 * a size without extra reads "—"; a cell saves by itself on a draft), what cells it is for, its quality checkpoint and its
 * machine settings — with the routing's minutes per garment by size and per work order above. Enter (or ⋯) opens a step's
 * times; ⋯ its variants, checkpoint and settings; with rows selected: Only for… N, Copy settings from the library N. A
 * released revision is drawn as text. It draws the view model and fetches nothing (use-routing-depth.ts loads it).
 */
export function DepthSection({ model, actions }: { model?: RoutingDepthModel; actions?: RoutingDepthActions }) {
  return (
    <WithMessages namespaces={['products-operations-depth']}>
      <Body model={model ?? NO_DEPTH} actions={actions} />
    </WithMessages>
  )
}

function Body({ model, actions }: { model: RoutingDepthModel; actions?: RoutingDepthActions }) {
  const t = useT('products-operations-depth')
  const tp = useT('products')
  if (model.depth.status === 'idle' && model.times.status === 'idle') return null
  const failed = model.depth.status === 'error' ? model.depth.problem : model.times.status === 'error' ? model.times.problem : null
  if (failed)
    return (
      <Banner tone="danger" title={t('depth.failed')} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{tp('common.retry')}</Button>}>
        {tp(failed)}
      </Banner>
    )
  if (model.depth.status !== 'ready' || model.times.status !== 'ready')
    return (
      <Card header={t('depth.title')} aria-busy="true">
        <p className="fw-rtd-hint" role="status">
          <Spinner size={14} /> {t('depth.loading')}
        </p>
        <div className="fw-rtd-stack">
          {Array.from({ length: 3 }, (_, index) => (
            <Skeleton key={index} height={22} />
          ))}
        </div>
      </Card>
    )
  return <Ready model={model} actions={actions} />
}

function Ready({ model, actions }: { model: RoutingDepthModel; actions?: RoutingDepthActions }) {
  const t = useT('products-operations-depth')
  const tp = useT('products')
  const locale = useLocale()
  const ds = useDsWords()
  const depth = model.depth.status === 'ready' ? model.depth.value : null
  const times = model.times.status === 'ready' ? model.times.value : null
  const rows = useMemo(() => rowsOf(depth, times), [depth, times])
  const held = depthHeld(depth, model.canManage)
  const busy = model.busy
  const sizes = depth?.sizes ?? []
  const latest = useRef({ actions, marks: model.marks, held, busy })
  latest.current = { actions, marks: model.marks, held, busy }
  const marksKey = JSON.stringify(model.marks)

  const columns = useMemo<ColDef<DepthRow>[]>(() => {
    const plain = { sortable: false, suppressHeaderMenuButton: true } as const
    const StepCell = ({ data }: ICellRendererParams<DepthRow>) =>
      data ? (
        <span className="fw-rtd-cell">
          <span>
            <b>{data.seq}</b> · {data.code}
          </span>
          <span className="fw-rtd-sub">{data.name}</span>
        </span>
      ) : null
    const RunCell = ({ data }: ICellRendererParams<DepthRow>) => {
      if (!data?.times) return <span className="fw-rtd-sub">—</span>
      const words = runWords(data.times)
      return (
        <span className="fw-rtd-cell">
          <span className="fw-rtd-num">{t('min', { minutes: minutesText(data.times.run.standardMinutes, locale) })}</span>
          <span className={data.times.library.differs ? 'fw-rtd-sub fw-rtd-warn' : 'fw-rtd-sub'}>
            {t(words.key, words.params)}
            {data.times.library.differs ? ` · ${t('run.library', { minutes: minutesText(data.times.library.standardMinutes, locale) })}` : ''}
          </span>
        </span>
      )
    }
    const SideCell = ({ data }: ICellRendererParams<DepthRow>) => {
      if (!data?.times) return <span className="fw-rtd-sub">—</span>
      const any = data.times.setupMinutes !== null || data.times.waitMinutes !== null || data.times.moveMinutes !== null
      return any ? (
        <span className="fw-rtd-cell">
          <span className="fw-rtd-num">{t('sideCol.values', { setup: sideText(data.times.setupMinutes), wait: sideText(data.times.waitMinutes), move: sideText(data.times.moveMinutes) })}</span>
          <span className="fw-rtd-sub">{t('sideCol.unit')}</span>
        </span>
      ) : (
        <span className="fw-rtd-sub">{t('sideCol.none')}</span>
      )
    }
    const sideText = (value: string | null) => (value === null ? '—' : minutesText(value, locale))
    const VariantsCell = ({ data }: ICellRendererParams<DepthRow>) => {
      const words = data?.depth?.variants.words
      return words ? <Tag tone="info">{words[locale]}</Tag> : <span className="fw-rtd-sub">{t('variants.every')}</span>
    }
    const CheckpointCell = ({ data }: ICellRendererParams<DepthRow>) => {
      const checkpoint = data?.depth?.checkpoint
      if (!checkpoint) return <span className="fw-rtd-sub">{t('checkpoint.none')}</span>
      return (
        <span className="fw-rtd-cell" title={checkpoint.does[locale]}>
          <span>
            <b>{checkpoint.plan.code}</b> {checkpoint.plan.name}
          </span>
          <span className={checkpoint.warning ? 'fw-rtd-sub fw-rtd-warn' : 'fw-rtd-sub'}>{checkpoint.warning ? checkpoint.warning[locale] : t(`stage.${checkpoint.plan.stage}`)}</span>
        </span>
      )
    }
    const SettingsCell = ({ data }: ICellRendererParams<DepthRow>) => {
      const step = data?.depth
      if (!step) return <span className="fw-rtd-sub">—</span>
      if (step.settings.length === 0) return <span className="fw-rtd-sub">{step.librarySettings > 0 ? t('settingsCol.library', { count: step.librarySettings }) : t('settingsCol.none')}</span>
      return (
        <span className="fw-rtd-cell" title={step.settings.map((setting) => setting.line[locale]).join('\n')}>
          <span>{step.settings[0]!.line[locale]}</span>
          {step.settings.length > 1 && <span className="fw-rtd-sub">{t('settingsCol.more', { count: step.settings.length - 1 })}</span>}
        </span>
      )
    }
    const SizeCell = (params: ICellRendererParams<DepthRow>) => {
      if (!params.data) return null
      const size = (params.colDef?.colId ?? '').replace(/^size:/, '')
      const mark = latest.current.marks[`${params.data.stepId}:${size}`]
      return (
        <span className="fw-rtd-sizecell">
          {mark && mark.state !== 'refused' ? (mark.value ?? ds.sizeColumns.notNeeded) : params.valueFormatted}
          <Mark mark={mark} />
        </span>
      )
    }
    const sizeCols = sizeColumns<DepthRow>({
      sizes: sizes.map((size) => size.code),
      unit: t('minUnit'),
      value: (row, size) => extraOf(row.times, size),
      editable: (row) => latest.current.held === null && row.times !== null,
      required: false,
      negative: true,
      scale: 3,
      onChange: (row, size, value) => latest.current.actions?.onSizeCell?.(row.stepId, size, value),
      onRefused: (row, size, text) => latest.current.actions?.onSizeCell?.(row.stepId, size, text),
      locale: INTL_LOCALE[locale],
      cellLabel: (row, size) => t('sizes.cell', { step: `${row.seq} · ${row.code}`, size }),
      labels: ds.sizeColumns,
    }).map((column) => ({ ...column, cellRenderer: SizeCell, headerName: sizes.find((size) => `size:${size.code}` === column.colId)?.label ?? column.headerName }))
    const MoreCell = ({ data }: ICellRendererParams<DepthRow>) => {
      if (!data) return null
      const why = latest.current.held ? t(latest.current.held) : undefined
      const items: MenuItemDef[] = [
        { id: 'times', label: t(why ? 'menu.timesView' : 'menu.times'), onSelect: () => latest.current.actions?.onDialog?.({ kind: 'times', stepId: data.stepId }) },
        { id: 'variants', label: t(why ? 'menu.variantsView' : 'menu.variants'), onSelect: () => latest.current.actions?.onDialog?.({ kind: 'variants', stepIds: [data.stepId] }) },
        { id: 'checkpoint', label: t(why ? 'menu.checkpointView' : 'menu.checkpoint'), onSelect: () => latest.current.actions?.onDialog?.({ kind: 'checkpoint', stepId: data.stepId }) },
        { id: 'settings', label: t(why ? 'menu.settingsView' : 'menu.settings'), onSelect: () => latest.current.actions?.onDialog?.({ kind: 'settings', stepId: data.stepId }) },
        {
          id: 'copy',
          label: t('menu.copyLibrary', { count: data.depth?.librarySettings ?? 0 }),
          disabled: !!why || (data.depth?.librarySettings ?? 0) === 0,
          description: why ?? ((data.depth?.librarySettings ?? 0) === 0 ? t('bulk.held.noLibrary') : undefined),
          onSelect: () => latest.current.actions?.onDialog?.({ kind: 'copyLibrary', stepIds: [data.stepId] }),
        },
      ]
      return <Menu label={<MoreHorizontal size={16} aria-label={t('menu.more', { step: `${data.seq} · ${data.code}` })} />} items={items} align="right" triggerProps={{ 'aria-label': t('menu.more', { step: `${data.seq} · ${data.code}` }) }} />
    }
    return [
      { colId: 'step', headerName: t('col.step'), minWidth: 190, flex: 1.4, pinned: 'left', cellRenderer: StepCell, valueGetter: (params) => (params.data ? `${params.data.seq} · ${params.data.code} · ${params.data.name}` : ''), ...plain },
      { colId: 'run', headerName: t('col.run'), minWidth: 150, flex: 1, cellRenderer: RunCell, valueGetter: (params) => params.data?.times?.run.standardMinutes ?? '', ...plain },
      { colId: 'side', headerName: t('col.side'), minWidth: 150, flex: 1, cellRenderer: SideCell, valueGetter: (params) => (params.data?.times ? [params.data.times.setupMinutes, params.data.times.waitMinutes, params.data.times.moveMinutes].map((value) => value ?? '—').join(' · ') : ''), ...plain },
      ...sizeCols,
      { colId: 'variants', headerName: t('col.variants'), minWidth: 170, flex: 1.1, cellRenderer: VariantsCell, valueGetter: (params) => params.data?.depth?.variants.words?.[locale] ?? t('variants.every'), ...plain },
      { colId: 'checkpoint', headerName: t('col.checkpoint'), minWidth: 170, flex: 1.1, cellRenderer: CheckpointCell, valueGetter: (params) => params.data?.depth?.checkpoint?.plan.code ?? t('checkpoint.none'), ...plain },
      { colId: 'settings', headerName: t('col.settings'), minWidth: 200, flex: 1.3, cellRenderer: SettingsCell, valueGetter: (params) => params.data?.depth?.settings[0]?.line[locale] ?? '', ...plain },
      { colId: 'more', headerName: t('col.more'), minWidth: 72, maxWidth: 72, pinned: 'right', suppressMovable: true, cellRenderer: MoreCell, ...plain },
    ]
  }, [t, locale, ds.sizeColumns, sizes.map((size) => size.code).join(','), marksKey])

  const picked = rows.filter((row) => model.selected.includes(row.stepId))
  const variantsHeld = held ? t(held) : busy ? t('held.busy') : null
  const copyHeld = copyLibraryHeld(picked, held, busy)
  const keys: ListKey[] = [{ keys: ['↵'], does: t('depthKeys.open') }]
  const totals = times ? times.bySize : []

  return (
    <section className="fw-rtd-stack" aria-label={t('depth.title')}>
      <Card header={t('depth.title')} description={t('depth.intro')}>
        <div className="fw-rtd-stack">
          <p className="fw-rtd-sum">
            <span>{t('depth.perGarment', { minutes: minutesText(times?.perGarment ?? '0', locale) })}</span>
            {totals.length > 0 && (
              <span className="fw-rtd-sub">
                {t('depth.bySize')} {totals.map((entry) => `${sizes.find((size) => size.code === entry.size)?.label ?? entry.size} ${minutesText(entry.minutes, locale)}`).join(' · ')}
              </span>
            )}
          </p>
          <p className="fw-rtd-sub">{t('depth.perOrder', { setup: minutesText(times?.setup ?? '0', locale), wait: minutesText(times?.wait ?? '0', locale), move: minutesText(times?.move ?? '0', locale) })}</p>
          {depth && !depth.options.available && <p className="fw-rtd-sub">{depth.options.words[locale]}</p>}
          {depth && depth.revision.effectiveFrom && (
            <p className="fw-rtd-sub">{depth.revision.effectiveTo ? t('depth.daysTo', { from: formatDate(depth.revision.effectiveFrom, { locale }), to: formatDate(depth.revision.effectiveTo, { locale }) }) : t('depth.daysFrom', { from: formatDate(depth.revision.effectiveFrom, { locale }) })}</p>
          )}
        </div>
      </Card>
      {held && held !== 'depth.held.frozen' && <Banner tone="info" title={t(held)} />}
      {model.offline && <Banner tone="warning" title={t('offline.cells', { count: Object.values(model.marks).filter((mark) => mark.state === 'waiting').length })} />}
      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={t(model.notice.key, model.notice.params)}
          action={
            <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
              {tp('common.dismiss')}
            </Button>
          }
        />
      )}
      <ListFrame<DepthRow>
        label={t('depth.table')}
        listKey={null}
        rows={rows}
        rowId={(row) => row.stepId}
        columns={columns}
        count={t('depth.count', { count: rows.length })}
        isRowSelectable={() => (held ? t(held) : null)}
        selection={{
          selected: model.selected,
          onChange: (ids) => actions?.onSelect?.(ids),
          actions: (
            <>
              <Button size="sm" aria-label={t('bulk.variants', { count: picked.length })} heldReason={variantsHeld} onClick={() => actions?.onDialog?.({ kind: 'variants', stepIds: picked.map((row) => row.stepId) })}>
                <Filter size={13} aria-hidden /> <SelectionLabel>{t('bulk.variants', { count: picked.length })}</SelectionLabel>
              </Button>
              <Button size="sm" aria-label={t('bulk.copy', { count: picked.length })} heldReason={copyHeld ? t(copyHeld) : null} onClick={() => actions?.onDialog?.({ kind: 'copyLibrary', stepIds: picked.map((row) => row.stepId) })}>
                <Copy size={13} aria-hidden /> <SelectionLabel>{t('bulk.copy', { count: picked.length })}</SelectionLabel>
              </Button>
            </>
          ),
        }}
        keys={keys}
        onOpen={(row) => actions?.onDialog?.({ kind: 'times', stepId: row.stepId })}
        state={rows.length === 0 ? <p className="fw-rtd-sub">{t('depth.empty')}</p> : undefined}
      />
      <DepthDialogs model={model} actions={actions} held={held} />
    </section>
  )
}

/** A size cell's save mark: saving (the DS CellSaveMark), refused ("!" with our words); nothing once saved. */
function Mark({ mark }: { mark: CellMark | undefined }) {
  const t = useT('products-operations-depth')
  if (!mark) return null
  if (mark.state === 'refused') {
    const reason = t(mark.problem ?? 'times.problem.refused')
    return (
      <span className="fw-rtd-refused" role="img" aria-label={reason} title={reason}>
        !
      </span>
    )
  }
  return <CellSaveMark state={mark.state} />
}
