'use client'

import { useMemo, useRef, type MouseEvent } from 'react'
import { Archive, ArchiveRestore, BarChart3, Plus } from 'lucide-react'
import { Banner, EmptyState } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { sizeColumns } from '@nexus/ui/grid/size-columns/index'
import { Button, Pill, SegmentedControl, Select } from '@nexus/ui/primitives'
import { useDsWords } from '../../../../../lib/i18n/ds-parts'
import { INTL_LOCALE } from '../../../../../lib/i18n/locales'
import { useLocale } from '../../../../../lib/i18n/provider'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import type { ListKey } from '../../../../../list-frame/model'
import { WithMessages } from '../../../../../record-panels/i18n'
import { Section } from '../../../../quality/_shared/parts'
import { percent } from '../../../quotes/model'
import { DEPTH_NS, type Tone, type Words } from '../../../quotes/record/lines-depth/model'
import { useDepthWords } from '../../../quotes/record/lines-depth/words'
import type { SizeCurve } from '../api'
import { curvesShown, movableCurves, scalesOf, type CurveStatusFilter } from '../model'
import { CurveDialog, type CurveDialogActions, type CurveDialogModel } from './CurveDialog'
import '../../../quotes/record/lines-depth/depth.css'

export interface CurvesModel {
  curves: { status: 'loading' } | { status: 'ready'; value: SizeCurve[] } | { status: 'error'; problem: string }
  /** The scale shown (its sizes are the columns); '' until one has curves. */
  scaleId: string
  status: CurveStatusFilter
  selected: readonly string[]
  /** quotes.templates.manage: the curves are kept beside the templates. */
  mayKeep: boolean
  busy: boolean
  notice: { words: Words; tone: Tone } | null
  dialog: CurveDialogModel | null
}

export interface CurvesActions {
  onScale?: (scaleId: string) => void
  onStatus?: (status: CurveStatusFilter) => void
  onSelect?: (ids: string[]) => void
  onOpen?: (id: string | 'new') => void
  onMove?: (to: 'archive' | 'restore') => void
  onRetry?: () => void
  onDismissNotice?: () => void
  dialog?: CurveDialogActions
}

/**
 * SCR-235 › Size curves (design sales.settings sec:ssettings.curves, SAL-269; B-W2b-302's API): saved percent curves for
 * the quote's "Fill by curve", one scale at a time in the ONE list frame — Curve name, whose, then the % per size of the
 * scale as DS SizeColumns, the total. New curve / a row opens it (the total shown live, Save held until 100 %); Archive N /
 * Restore N, all or none.
 */
export function CurvesView({ model, actions }: { model: CurvesModel; actions?: CurvesActions }) {
  return (
    <WithMessages namespaces={['sales', DEPTH_NS]}>
      <Curves model={model} actions={actions} />
    </WithMessages>
  )
}

function Curves({ model, actions }: { model: CurvesModel; actions?: CurvesActions }) {
  const { t, say } = useDepthWords()
  const locale = useLocale()
  const ds = useDsWords()
  const latest = useRef(actions)
  latest.current = actions
  const all = model.curves.status === 'ready' ? model.curves.value : []
  const scales = scalesOf(all)
  const scale = scales.find((entry) => entry.id === model.scaleId) ?? scales[0] ?? null
  const rows = model.curves.status === 'ready' ? (scale ? curvesShown(all, scale.id, model.status) : []) : null

  const columns = useMemo<ColDef<SizeCurve>[]>(() => {
    const open = (event: MouseEvent, id: string) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return
      event.preventDefault()
      latest.current?.onOpen?.(id)
    }
    const NameCell = ({ data }: ICellRendererParams<SizeCurve>) =>
      data ? (
        <button type="button" className="fw-qd-rowlink" onClick={(event) => open(event, data.id)}>
          <strong>{data.name}</strong>
        </button>
      ) : null
    const StatusCell = ({ data }: ICellRendererParams<SizeCurve>) => (data ? <Pill tone={data.status === 'ACTIVE' ? 'success' : 'neutral'}>{t(`tpl.status.${data.status}`)}</Pill> : null)
    return [
      { colId: 'name', headerName: t('curve.col.name'), minWidth: 200, flex: 1.4, pinned: 'left', cellRenderer: NameCell, valueGetter: (params) => params.data?.name ?? '' },
      { colId: 'company', headerName: t('curve.col.company'), minWidth: 150, valueGetter: (params) => (params.data ? (params.data.company ? params.data.company.code : t('tpl.everyCompany')) : '') },
      ...(scale ? sizeColumns<SizeCurve>({ sizes: scale.sizes, value: (row, size) => row.shares[size] ?? null, unit: '%', required: false, locale: INTL_LOCALE[locale], labels: ds.sizeColumns }) : []),
      { colId: 'total', headerName: t('curve.col.total'), minWidth: 100, type: 'rightAligned', valueGetter: (params) => (params.data ? percent(String(Object.values(params.data.shares).reduce((sum, share) => sum + Number(share), 0)), locale) : '') },
      { colId: 'status', headerName: t('curve.col.status'), minWidth: 120, cellRenderer: StatusCell, valueGetter: (params) => params.data?.status ?? '' },
    ]
  }, [t, locale, scale, ds.sizeColumns])

  const heldMove = (to: 'archive' | 'restore') => (!model.mayKeep ? t('curve.held.right') : model.busy ? t('common.working') : movableCurves(all, model.selected, to).length === 0 ? t(to === 'archive' ? 'tpl.held.noneActive' : 'tpl.held.noneArchived') : null)
  const count = (to: 'archive' | 'restore') => movableCurves(all, model.selected, to).length
  const keys: ListKey[] = [{ keys: ['c'], does: t('curve.keys.new') }]
  return (
    <Section
      id="size-curves"
      title={t('curve.title')}
      sub={t('curve.sub')}
      actions={
        <Button size="sm" variant="primary" heldReason={model.mayKeep ? null : t('curve.held.right')} onClick={() => actions?.onOpen?.('new')}>
          <Plus size={14} aria-hidden /> {t('curve.new')}
        </Button>
      }
    >
      <div className="fw-q-stack">
        {model.notice && (
          <Banner
            tone={model.notice.tone}
            title={say(model.notice.words)}
            action={
              <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
                {t('common.dismiss')}
              </Button>
            }
          />
        )}
        <ListFrame<SizeCurve>
          label={t('curve.title')}
          title={t('curve.title')}
          listKey={null}
          rows={model.curves.status === 'error' ? [] : rows}
          rowId={(row) => row.id}
          columns={columns}
          count={rows ? t('curve.count', { count: rows.length }) : t('common.loading')}
          tools={
            <>
              {scales.length > 0 && (
                <Select size="sm" aria-label={t('curve.scale')} value={scale?.id ?? ''} onChange={(event) => actions?.onScale?.(event.target.value)}>
                  {scales.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {t('curve.scaleOption', { code: entry.code, name: entry.name })}
                    </option>
                  ))}
                </Select>
              )}
              <SegmentedControl size="sm" ariaLabel={t('tpl.statusLabel')} value={model.status} onChange={(value) => actions?.onStatus?.(value as CurveStatusFilter)} options={(['ACTIVE', 'ARCHIVED', 'ALL'] as const).map((value) => ({ value, label: t(`tpl.filter.${value}`) }))} />
            </>
          }
          selection={{
            selected: model.selected,
            onChange: (ids) => actions?.onSelect?.(ids),
            actions: (
              <>
                <Button size="sm" heldReason={heldMove('archive')} onClick={() => actions?.onMove?.('archive')} aria-label={t('curve.bulk.archive', { count: count('archive') })}>
                  <Archive size={13} aria-hidden /> <SelectionLabel>{t('curve.bulk.archive', { count: count('archive') })}</SelectionLabel>
                </Button>
                <Button size="sm" heldReason={heldMove('restore')} onClick={() => actions?.onMove?.('restore')} aria-label={t('curve.bulk.restore', { count: count('restore') })}>
                  <ArchiveRestore size={13} aria-hidden /> <SelectionLabel>{t('curve.bulk.restore', { count: count('restore') })}</SelectionLabel>
                </Button>
              </>
            ),
          }}
          keys={keys}
          onOpen={(row) => actions?.onOpen?.(row.id)}
          state={
            model.curves.status === 'error' ? (
              <EmptyState
                title={t('curve.failed')}
                description={say({ ns: 'sales', key: model.curves.problem })}
                action={
                  <Button size="sm" onClick={() => actions?.onRetry?.()}>
                    {t('common.retry')}
                  </Button>
                }
              />
            ) : rows && rows.length === 0 ? (
              <EmptyState icon={<BarChart3 size={22} aria-hidden />} title={t(all.length === 0 ? 'curve.empty' : 'curve.emptyHere')} description={t('curve.emptyBody')} />
            ) : undefined
          }
        />
        <p className="fw-q-hint">{t('curve.how')}</p>
        {model.dialog && <CurveDialog model={model.dialog} actions={actions?.dialog} />}
      </div>
    </Section>
  )
}
