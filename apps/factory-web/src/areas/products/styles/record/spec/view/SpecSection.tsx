'use client'

import { useMemo, useRef } from 'react'
import { Check, ClipboardPaste, Lock, MoreHorizontal, Plus, RotateCcw, Ruler, Trash2, WandSparkles, WifiOff } from 'lucide-react'
import { Banner, Card, EmptyState, Menu, type MenuItemDef } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { sizeColumns } from '@nexus/ui/grid/size-columns/index'
import { Button, Pill, Skeleton, Spinner, Tag } from '@nexus/ui/primitives'
import { useDsWords } from '../../../../../../lib/i18n/ds-parts'
import { formatTime } from '../../../../../../lib/i18n/format'
import { INTL_LOCALE } from '../../../../../../lib/i18n/locales'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../../record-panels/i18n'
import { ListFrame } from '../../../../../../list-frame/ListFrame'
import type { ListKey } from '../../../../../../list-frame/model'
import { Mark, PictureCard } from '../../../../sizes/depth/view/PomsView'
import type { StyleView } from '../../../api'
import { draftOf, nextRevisionNumber, startRevisionHeld } from '../../../model'
import type { StyleRecordActions, StyleRecordViewModel } from '../../record-model'
import type { MeasurementSpecView } from '../api'
import { approveHeld, isOverride, missingCount, NO_SPEC, reopenHeld, specHeld, specMarkKey, specRowsOf, startHeld, toleranceOf, toleranceText, type SpecActions, type SpecModel, type SpecRow } from '../spec-model'
import { SpecDialogs } from './SpecDialogs'
import '../spec.css'

/**
 * SCR-344 — the style's Measurement spec (B-W2b-240; design products.styles › Sizes & measurements › style.sizes.spec,
 * PRD-063, PRD-051, PRD-052): points of measure × the sizes of the revision's range, graded from the base size. One row
 * per point on the shared list frame — its code and name (the how-to picture in a card), its tolerance, a value per size
 * (SizeColumns: the base size marked, a value typed by hand among graded ones marked, a missing value said "missing",
 * never 0) and ⋯ (fill from the base by an increment, tolerance, move, remove); with rows selected, Remove N. Above it:
 * the spec's state, base size and grade rule, what is still missing, Add points, Apply grade rule (a preview of the
 * changed cells; typed values kept unless chosen), Paste from a sheet, Approve / Reopen. Revision-bound: a released
 * revision's spec is drawn as text and says why. It draws the view model and fetches nothing (use-spec.ts loads it).
 */
export function SpecSection({ style, model, spec, actions, recordActions }: { style: StyleView; model: StyleRecordViewModel; spec?: SpecModel; actions?: SpecActions; recordActions?: StyleRecordActions }) {
  return (
    <WithMessages namespaces={['products-sizes-depth', 'products', 'lists']}>
      <Body style={style} record={model} model={spec ?? NO_SPEC} actions={actions} recordActions={recordActions} />
    </WithMessages>
  )
}

function Body({ style, record, model, actions, recordActions }: { style: StyleView; record: StyleRecordViewModel; model: SpecModel; actions?: SpecActions; recordActions?: StyleRecordActions }) {
  const t = useT('products-sizes-depth')
  const part = model.part
  if (part.status === 'idle') return null
  if (part.status === 'error')
    return (
      <Banner
        tone="danger"
        title={t('spec.failed')}
        action={
          <Button size="sm" onClick={() => actions?.onRetry?.()}>
            {t('common.retry')}
          </Button>
        }
      >
        {t(part.problem)}
      </Banner>
    )
  if (part.status === 'loading')
    return (
      <Card header={t('spec.title')} headingLevel={2} aria-busy="true">
        <p className="fw-spc-sub" role="status">
          <Spinner size={14} /> {t('spec.loading')}
        </p>
        <div className="fw-spc-stack">
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} height={22} />
          ))}
        </div>
      </Card>
    )
  return <Ready style={style} record={record} view={part.value} model={model} actions={actions} recordActions={recordActions} />
}

function Ready({ style, record, view, model, actions, recordActions }: { style: StyleView; record: StyleRecordViewModel; view: MeasurementSpecView; model: SpecModel; actions?: SpecActions; recordActions?: StyleRecordActions }) {
  const t = useT('products-sizes-depth')
  const tp = useT('products')
  const locale = useLocale()
  const ds = useDsWords()
  const rows = useMemo(() => specRowsOf(view), [view])
  const spec = view.spec
  const held = spec ? specHeld(view, model.can) : startHeld(view, model.can)
  const editable = spec !== null && held === null
  const base = spec?.baseSize ?? view.style.baseSize
  const sizes = view.sizes.map((size) => size.code)
  const missing = missingCount(view)
  const latest = useRef({ actions, model, editable })
  latest.current = { actions, model, editable }
  const marksKey = JSON.stringify(model.marks)
  const looksKey = JSON.stringify(model.looks)
  const busy = model.busy
  const draft = draftOf(style.revisions)
  const startRevision = startRevisionHeld(style, record.can)
  const next = nextRevisionNumber(style.revisions)
  const frozen = view.revision.status !== 'DRAFT'

  const columns = useMemo<ColDef<SpecRow>[]>(() => {
    const plain = { sortable: false, suppressHeaderMenuButton: true } as const
    const PointCell = ({ data }: ICellRendererParams<SpecRow>) =>
      data ? (
        <span className="fw-spc-point">
          {data.point.hasPicture && <PictureCard point={data.point} look={latest.current.model.looks[data.id]} onLook={() => latest.current.actions?.onLook?.(data.id)} />}
          <span className="fw-spc-cell">
            <b>{data.point.code}</b>
            <span className="fw-spc-sub" title={data.point.howTo ?? undefined}>
              {data.point.nameI18n?.[locale] ?? data.point.name}
              {data.point.status === 'ARCHIVED' ? ` · ${t('status.ARCHIVED')}` : ''}
            </span>
          </span>
        </span>
      ) : null
    const ToleranceCell = ({ data }: ICellRendererParams<SpecRow>) => {
      if (!data) return null
      const tolerance = toleranceOf(data, base)
      return (
        <span className="fw-spc-cell">
          <span>{toleranceText(tolerance, data.point.uom, locale)}</span>
          {tolerance?.varies && <span className="fw-spc-sub">{t('spec.tolerance.varies')}</span>}
        </span>
      )
    }
    const SizeCell = (params: ICellRendererParams<SpecRow>) => {
      if (!params.data) return null
      const size = (params.colDef?.colId ?? '').replace(/^size:/, '')
      const mark = latest.current.model.marks[specMarkKey(params.data.id, size)]
      return (
        <span className="fw-spc-sizecell">
          {mark && mark.state !== 'refused' ? (mark.value ?? ds.sizeColumns.notNeeded) : params.valueFormatted}
          <Mark mark={mark} />
        </span>
      )
    }
    const sizeCols = sizeColumns<SpecRow>({
      sizes,
      base,
      value: (row, size) => row.cells[size]?.nominal ?? null,
      editable: () => latest.current.editable,
      required: true,
      isOverride: (row, size) => isOverride(row, size, base),
      scale: 2,
      onChange: (row, size, value) => latest.current.actions?.onCell?.(row.id, size, value),
      onRefused: (row, size, text) => latest.current.actions?.onRefused?.(row.id, size, text),
      locale: INTL_LOCALE[locale],
      cellLabel: (row, size) => t('spec.cell', { code: row.point.code, size }),
      labels: ds.sizeColumns,
    }).map((column) => {
      const size = view.sizes.find((entry) => `size:${entry.code}` === column.colId)
      return { ...column, cellRenderer: SizeCell, headerTooltip: size?.label ? `${size.code} · ${size.label}` : column.headerTooltip }
    })
    const MoreCell = ({ data }: ICellRendererParams<SpecRow>) => {
      if (!data) return null
      const why = latest.current.editable ? undefined : t(held ?? 'spec.held.noManage')
      const index = rows.findIndex((row) => row.id === data.id)
      const items: MenuItemDef[] = [
        { id: 'fill', label: t('spec.menu.fill'), disabled: !!why, description: why, onSelect: () => latest.current.actions?.onDialog?.({ kind: 'fill', pointId: data.id }) },
        { id: 'tolerance', label: t('spec.menu.tolerance'), disabled: !!why, description: why, onSelect: () => latest.current.actions?.onDialog?.({ kind: 'tolerance', pointId: data.id }) },
        { id: 'up', label: t('spec.menu.up'), disabled: !!why || index === 0, description: why ?? (index === 0 ? t('spec.menu.first') : undefined), onSelect: () => latest.current.actions?.onMove?.(data.id, -1) },
        { id: 'down', label: t('spec.menu.down'), disabled: !!why || index === rows.length - 1, description: why ?? (index === rows.length - 1 ? t('spec.menu.last') : undefined), onSelect: () => latest.current.actions?.onMove?.(data.id, 1) },
        { id: 'remove', label: t('spec.menu.remove'), tone: 'danger', disabled: !!why, description: why, onSelect: () => latest.current.actions?.onDialog?.({ kind: 'remove', ids: [data.id] }) },
      ]
      return <Menu label={<MoreHorizontal size={16} aria-hidden />} align="right" triggerProps={{ 'aria-label': t('spec.menu.more', { code: data.point.code }) }} items={items} />
    }
    return [
      { colId: 'point', headerName: t('spec.col.point'), minWidth: 200, flex: 1.3, pinned: 'left', valueGetter: (params) => params.data?.point.code ?? '', cellRenderer: PointCell, ...plain },
      { colId: 'tolerance', headerName: t('spec.col.tolerance'), minWidth: 130, flex: 0.8, valueGetter: (params) => (params.data ? toleranceText(toleranceOf(params.data, base), params.data.point.uom, locale) : ''), cellRenderer: ToleranceCell, ...plain },
      ...sizeCols,
      { colId: 'more', headerName: t('spec.col.more'), minWidth: 72, maxWidth: 72, pinned: 'right', suppressMovable: true, cellRenderer: MoreCell, ...plain },
    ]
  }, [t, locale, ds.sizeColumns, sizes.join(','), base, marksKey, looksKey, rows, held])

  const picked = rows.filter((row) => model.selected.includes(row.id))
  const editHeld = held ? t(held) : busy ? t('held.busy') : null
  const gradeButtonHeld = held ? t(held) : rows.length === 0 ? t('spec.held.noPoints') : busy ? t('held.busy') : null
  const keys: ListKey[] = [{ keys: ['↵'], does: t('spec.keys.cell') }]
  const approving = spec?.status === 'APPROVED' ? reopenHeld(view, model.can, busy) : spec ? approveHeld(view, model.can, busy) : null
  const startButtonHeld = held ? t(held) : busy ? t('held.busy') : null

  const primary = spec ? (
    <Button size="sm" variant="primary" heldReason={editHeld} onClick={() => actions?.onDialog?.({ kind: 'add' })}>
      <Plus size={13} aria-hidden /> {t('spec.add')}
    </Button>
  ) : (
    <Button size="sm" variant="primary" heldReason={startButtonHeld} onClick={() => actions?.onDialog?.({ kind: 'start' })}>
      <Plus size={13} aria-hidden /> {t('spec.startButton')}
    </Button>
  )
  const more: MenuItemDef[] = spec
    ? [
        { id: 'settings', label: t('spec.menu.settings'), disabled: !!held, description: held ? t(held) : undefined, onSelect: () => actions?.onDialog?.({ kind: 'settings' }) },
        { id: 'archive', label: t('spec.menu.archive'), tone: 'danger', disabled: frozen || !model.can.manage || spec.status === 'ARCHIVED', description: frozen ? t('spec.held.frozen') : !model.can.manage ? t('spec.held.noManage') : undefined, onSelect: () => actions?.onDialog?.({ kind: 'archive' }) },
      ]
    : []

  return (
    <section className="fw-spc-stack" aria-label={t('spec.title')}>
      <Card header={t('spec.title')} headingLevel={2} description={t('spec.intro', { revision: view.revision.revision })} headerAction={primary}>
        <div className="fw-spc-stack">
          {spec && (
            <div className="fw-spc-facts">
              <Pill tone={spec.status === 'APPROVED' ? 'success' : spec.status === 'ARCHIVED' ? 'neutral' : 'info'}>{t(`spec.status.${spec.status}`)}</Pill>
              <Tag tone="neutral">{t('spec.base', { size: spec.baseSize })}</Tag>
              <Tag tone="neutral">{spec.gradeRule ? t('spec.rule', { code: spec.gradeRule.code }) : t('spec.ruleNone')}</Tag>
              <span className={missing > 0 ? 'fw-spc-warn' : 'fw-spc-sub'}>{missing > 0 ? t('spec.missing', { count: missing }) : rows.length > 0 ? t('spec.complete') : t('spec.noPoints')}</span>
              {spec.approvedAt && <span className="fw-spc-sub">{t('spec.approvedAt', { time: formatTime(spec.approvedAt, { locale }) })}</span>}
            </div>
          )}
          {spec && (
            <div className="fw-spc-actions">
              <Button size="sm" heldReason={gradeButtonHeld} onClick={() => actions?.onDialog?.({ kind: 'grade' })}>
                <WandSparkles size={13} aria-hidden /> {t('spec.gradeButton')}
              </Button>
              <Button size="sm" heldReason={gradeButtonHeld} onClick={() => actions?.onDialog?.({ kind: 'paste' })}>
                <ClipboardPaste size={13} aria-hidden /> {t('spec.pasteButton')}
              </Button>
              {spec.status === 'APPROVED' ? (
                <Button size="sm" heldReason={approving ? t(approving) : null} onClick={() => actions?.onDialog?.({ kind: 'reopen' })}>
                  <RotateCcw size={13} aria-hidden /> {t('spec.reopen')}
                </Button>
              ) : spec.status === 'DRAFT' ? (
                <Button size="sm" heldReason={approving ? t(approving, { count: missing }) : null} onClick={() => actions?.onDialog?.({ kind: 'approve' })}>
                  <Check size={13} aria-hidden /> {t('spec.approve')}
                </Button>
              ) : null}
              {more.length > 0 && <Menu label={<MoreHorizontal size={16} aria-hidden />} align="right" triggerProps={{ 'aria-label': t('spec.menu.specMore') }} items={more} />}
            </div>
          )}
          {frozen && (
            <p className="fw-spc-frozen">
              <Lock size={14} aria-hidden /> {t(view.revision.status === 'RELEASED' ? 'spec.frozen.released' : 'spec.frozen.obsolete', { revision: view.revision.revision })}
              {draft && draft.id !== view.revision.id ? (
                <Button size="sm" variant="quiet" onClick={() => recordActions?.onRevision?.(draft.id)}>
                  {tp('record.goToDraft', { revision: draft.revision })}
                </Button>
              ) : !startRevision ? (
                <Button size="sm" variant="quiet" onClick={() => recordActions?.onDialog?.({ kind: 'startRevision' })}>
                  {tp('action.startRevision', { revision: next })}
                </Button>
              ) : null}
            </p>
          )}
        </div>
      </Card>
      {held && !frozen && held !== 'spec.held.noRange' && <Banner tone="info" title={t(held.replace('spec.held.', 'spec.banner.'))} />}
      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={t(model.notice.key, model.notice.params)}
          action={
            <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
              {t('common.dismiss')}
            </Button>
          }
        />
      )}
      {(model.offline || Object.values(model.marks).some((mark) => mark.state === 'waiting')) && (
        <Banner
          tone="warning"
          title={
            <span className="fw-spc-inline">
              <WifiOff size={14} aria-hidden /> {t('spec.offline', { count: Object.values(model.marks).filter((mark) => mark.state === 'waiting').length })}
            </span>
          }
        />
      )}
      {spec && missing > 0 && rows.length > 0 && (
        <Banner tone="warning" title={t('spec.missingTitle', { count: missing })}>
          <ul className="fw-spc-list">
            {view.missing.slice(0, 8).map((entry) => (
              <li key={entry.pointOfMeasureId}>{t('spec.missingLine', { code: entry.code, sizes: entry.sizes.join(', ') })}</li>
            ))}
          </ul>
        </Banner>
      )}
      {!spec ? (
        <Card padded>
          <EmptyState
            icon={<Ruler size={24} aria-hidden />}
            title={t('spec.empty.title')}
            description={t(view.sizes.length === 0 ? 'spec.held.noRange' : held ? 'spec.empty.held' : 'spec.empty.body', { revision: view.revision.revision })}
            action={held ? undefined : primary}
          />
        </Card>
      ) : (
        <ListFrame<SpecRow>
          label={t('spec.table')}
          listKey={null}
          rows={rows}
          rowId={(row) => row.id}
          columns={columns}
          count={t('spec.count', { count: rows.length, sizes: sizes.length })}
          isRowSelectable={() => (editable ? null : t(held ?? 'spec.held.noManage'))}
          selection={{
            selected: model.selected,
            onChange: (ids) => actions?.onSelect?.(ids),
            actions: (
              <Button size="sm" variant="danger-outline" aria-label={t('spec.bulk.remove', { count: picked.length })} heldReason={editHeld} onClick={() => actions?.onDialog?.({ kind: 'remove', ids: picked.map((row) => row.id) })}>
                <Trash2 size={13} aria-hidden /> <SelectionLabel>{t('spec.bulk.remove', { count: picked.length })}</SelectionLabel>
              </Button>
            ),
          }}
          keys={keys}
          focusRow={model.focusRow}
          state={
            rows.length === 0 ? (
              <EmptyState
                title={t('spec.empty.title')}
                description={t(editable ? 'spec.empty.points' : 'spec.empty.frozen')}
                action={
                  editable ? (
                    <Button size="sm" variant="primary" onClick={() => actions?.onDialog?.({ kind: 'add' })}>
                      <Plus size={13} aria-hidden /> {t('spec.add')}
                    </Button>
                  ) : undefined
                }
              />
            ) : undefined
          }
        />
      )}
      {spec && rows.length > 0 && (
        <p className="fw-spc-sub">{t('spec.legend', { base: base ?? '—' })}</p>
      )}
      <SpecDialogs view={view} rows={rows} model={model} held={held} actions={actions} />
    </section>
  )
}
