'use client'

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { Factory, Percent } from 'lucide-react'
import { Banner, EmptyState, Field, Modal, Sparkline } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Spinner } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import type { ListKey } from '../../../../../list-frame/model'
import { INTL_LOCALE } from '../../../../../lib/i18n/locales'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { Lane, PlanningSite } from '../../api'
import { manageHeld, type SettingsCan } from '../../model'
import { ReadFailed } from '../../view/parts'
import { latestActual, laneKey, markKey, PARAMS_NAMESPACES, pctOf, percentEdit, sparkOf, type LaneField, type Mark, type Notice } from '../model'
import { cellKeys, ElsewhereBanner, KeysDialog, NoticeBanner, SaveMark, useSay } from './cells'
import '../params.css'

/** The ONE view model of Line efficiency. It fetches nothing. Per line and work centre only: never a person. */
export interface EfficiencyModel {
  prefix: string
  site: PlanningSite
  can: SettingsCan
  load: { status: 'loading' } | { status: 'error'; problem: string } | { status: 'ready' }
  lanes: { lines: readonly Lane[]; workCentres: readonly Lane[]; defaultEfficiencyPct: string; defaultEfficiencySource: 'SITE' | 'DEFAULT' } | null
  marks: Readonly<Record<string, Mark>>
  notice: Notice | null
  changedElsewhere: boolean
  busy: boolean
  /** Design cases: lanes selected, the bulk dialog open. */
  selected?: readonly string[]
  bulkOpen?: boolean
  focusRow?: number
}

export interface EfficiencyActions {
  onRetry?: () => void
  onReload?: () => void
  onCell?: (lane: Lane, field: LaneField, raw: unknown) => void
  /** "Set the planned % of N": the same percent on each lane, one write after the other. */
  onBulkPct?: (lanes: readonly Lane[], value: string) => Promise<boolean>
  onDismissNotice?: () => void
}

export function EfficiencyView({ model, actions }: { model: EfficiencyModel; actions?: EfficiencyActions }) {
  return (
    <WithMessages namespaces={PARAMS_NAMESPACES}>
      <Efficiency model={model} actions={actions} />
    </WithMessages>
  )
}

function Efficiency({ model, actions }: { model: EfficiencyModel; actions?: EfficiencyActions }) {
  const t = useT('planning-params')
  const ts = useT('planning-settings')
  const locale = INTL_LOCALE[useLocale()]
  const held = manageHeld('efficiency', model.can)
  const heldText = held ? ts(held) : null
  const can = !held
  const [keysOpen, setKeysOpen] = useState(false)
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  useEffect(() => setSelected(model.selected ?? []), [model.selected])
  const [bulkOpen, setBulkOpen] = useState(!!model.bulkOpen)
  const latest = useRef({ model, actions })
  latest.current = { model, actions }
  const marksKey = JSON.stringify(model.marks)
  const rows = model.lanes ? [...model.lanes.lines, ...model.lanes.workCentres] : null

  const columns = useMemo<ColDef<Lane>[]>(() => {
    const mark = (lane: Lane, field: string) => latest.current.model.marks[markKey(laneKey(lane), field)]
    const LaneCell = ({ data }: ICellRendererParams<Lane>) =>
      data ? (
        <span className="fw-pp-two">
          <span className="fw-pp-code">{data.code}</span>
          <span className="fw-pp-sub">{data.name}</span>
        </span>
      ) : null
    const KindCell = ({ data }: ICellRendererParams<Lane>) => (data ? <span>{data.kind === 'LINE' ? t('pp.lane.line') : t('pp.lane.workCentre', { kind: data.workCentreKind ? t(`pp.wcKind.${data.workCentreKind}`) : t('pp.lane.workshop') })}</span> : null)
    const PctCell = ({ data }: ICellRendererParams<Lane>) =>
      data ? (
        <span className="fw-pp-cell num">
          <span className={data.effective.efficiencySource === 'LANE' ? undefined : 'fw-pp-sub'}>{t('pp.pct', { pct: pctOf(data.effective.efficiencyPct, locale) })}</span>
          <SaveMark mark={mark(data, 'plannedEfficiencyPct')} />
        </span>
      ) : null
    const SourceCell = ({ data }: ICellRendererParams<Lane>) => (data ? <span className="fw-pp-sub">{t(`pp.effSource.${data.effective.efficiencySource}`)}</span> : null)
    const PeopleCell = ({ data }: ICellRendererParams<Lane>) =>
      data ? (
        <span className="fw-pp-cell num">
          <span className={data.effective.peopleSource === 'CAPACITY' ? undefined : 'fw-pp-sub'}>
            {data.effective.peopleSource === 'CAPACITY' ? t(data.kind === 'LINE' ? 'pp.people.planned' : 'pp.units.planned', { count: data.effective.people }) : t('pp.people.stations', { count: data.effective.people })}
          </span>
          <SaveMark mark={mark(data, 'people')} />
        </span>
      ) : null
    const ActualCell = ({ data }: ICellRendererParams<Lane>) => {
      if (!data) return null
      if (data.actual === null) return <span className="fw-pp-sub">{t('pp.actual.none')}</span>
      const last = latestActual(data)
      const values = sparkOf(data)
      return (
        <span className="fw-pp-spark">
          <Sparkline values={values} shape="line" domain={[0, null]} label={t('pp.actual.label', { lane: data.code })} format={(n) => t('pp.pct', { pct: pctOf(String(n), locale) })} emptyLabel={t('pp.actual.empty')} />
          <span className="fw-pp-sub">{last?.pct ? t('pp.actual.last', { pct: pctOf(last.pct, locale) }) : t('pp.actual.lastNone')}</span>
        </span>
      )
    }
    const editable = can ? { editable: true, cellEditor: 'agTextCellEditor', cellEditorParams: { maxLength: 8 } } : {}
    return [
      { colId: 'lane', headerName: t('pp.col.lane'), minWidth: 190, flex: 1.4, cellRenderer: LaneCell, suppressKeyboardEvent: cellKeys() },
      { colId: 'kind', headerName: t('pp.col.kind'), minWidth: 150, flex: 1, cellRenderer: KindCell, suppressKeyboardEvent: cellKeys() },
      { colId: 'stations', headerName: t('pp.col.stations'), minWidth: 100, flex: 0.6, type: 'rightAligned', valueGetter: (params) => params.data?.stations ?? null, suppressKeyboardEvent: cellKeys() },
      {
        colId: 'plannedEfficiencyPct',
        headerName: t('pp.col.plannedEfficiencyPct'),
        minWidth: 140,
        flex: 0.9,
        ...editable,
        valueGetter: (params) => (params.data ? String(Number(params.data.effective.efficiencyPct)) : ''),
        valueSetter: (params) => {
          if (params.data) latest.current.actions?.onCell?.(params.data, 'plannedEfficiencyPct', params.newValue)
          return false
        },
        cellRenderer: PctCell,
        suppressKeyboardEvent: cellKeys(),
      },
      { colId: 'source', headerName: t('pp.col.effSource'), minWidth: 150, flex: 1, cellRenderer: SourceCell, suppressKeyboardEvent: cellKeys() },
      {
        colId: 'people',
        headerName: t('pp.col.people'),
        minWidth: 170,
        flex: 1,
        ...editable,
        valueGetter: (params) => (params.data?.capacity?.people == null ? '' : String(params.data.capacity.people)),
        valueSetter: (params) => {
          if (params.data) latest.current.actions?.onCell?.(params.data, 'people', params.newValue)
          return false
        },
        cellRenderer: PeopleCell,
        suppressKeyboardEvent: cellKeys(),
      },
      { colId: 'actual', headerName: t('pp.col.actual'), minWidth: 200, flex: 1.2, cellRenderer: ActualCell, suppressKeyboardEvent: cellKeys() },
    ]
  }, [t, locale, can, marksKey])

  const ownKeys: ListKey[] = can
    ? [
        { keys: ['↵'], does: t('pp.keys.edit') },
        { keys: ['Esc'], does: t('pp.keys.cancel') },
      ]
    : []
  const ready = model.load.status === 'ready' && rows !== null
  let state: ReactNode = undefined
  if (model.load.status === 'error') state = <ReadFailed title={t('pp.efficiency.failed')} problem={model.load.problem} onRetry={actions?.onRetry} />
  else if (ready && model.lanes!.lines.length === 0 && model.lanes!.workCentres.length === 0)
    state = (
      <EmptyState
        icon={<Factory size={22} aria-hidden />}
        title={t('pp.efficiency.empty.title')}
        description={t('pp.efficiency.empty.body')}
        action={
          <Button size="sm" asChild>
            <Link href={`${model.prefix}/admin/companies/${encodeURIComponent(model.site.companyId)}/sites/${encodeURIComponent(model.site.id)}?tab=structure`}>{t('pp.efficiency.empty.action')}</Link>
          </Button>
        }
      />
    )

  return (
    <section className="fw-pp" aria-label={t('pp.efficiency.title')}>
      <p className="fw-ps-hint">
        {model.lanes
          ? t(model.lanes.defaultEfficiencySource === 'SITE' ? 'pp.efficiency.hintSite' : 'pp.efficiency.hintDefault', { pct: pctOf(model.lanes.defaultEfficiencyPct, locale) })
          : t('pp.efficiency.hint')}
      </p>
      {model.changedElsewhere && <ElsewhereBanner onReload={actions?.onReload} />}
      <NoticeBanner notice={model.notice} onDismiss={actions?.onDismissNotice} />
      {ready && !can && <Banner tone="neutral" title={t('pp.readOnly.title')}>{heldText}</Banner>}
      <ListFrame<Lane>
        label={t('pp.efficiency.table')}
        listKey="planning.settings.efficiency"
        rows={state ? [] : rows}
        rowId={laneKey}
        columns={columns}
        rowKind="two-line"
        count={model.lanes ? t('pp.efficiency.count', { lines: model.lanes.lines.length, centres: model.lanes.workCentres.length }) : '—'}
        selection={
          ready
            ? {
                selected,
                onChange: setSelected,
                actions: (
                  <Button size="sm" variant="primary" aria-label={t('pp.efficiency.bulk', { count: selected.length })} heldReason={heldText ?? (model.busy ? ts('ps.held.busy') : null)} onClick={() => setBulkOpen(true)}>
                    <Percent size={13} aria-hidden /> <SelectionLabel>{t('pp.efficiency.bulk', { count: selected.length })}</SelectionLabel>
                  </Button>
                ),
              }
            : undefined
        }
        keys={ownKeys}
        onHelp={() => setKeysOpen(true)}
        state={state}
        focusRow={model.focusRow}
      />
      <p className="fw-pp-later">{t('pp.efficiency.privacy')}</p>
      {keysOpen && <KeysDialog keys={ownKeys} selection onClose={() => setKeysOpen(false)} />}
      {bulkOpen && <BulkPctDialog lanes={(rows ?? []).filter((lane) => selected.includes(laneKey(lane)))} busy={model.busy} actions={actions} onClose={() => setBulkOpen(false)} onDone={() => setSelected([])} />}
    </section>
  )
}

/** The same planned percent on the selected lines and work centres. */
function BulkPctDialog({ lanes, busy, actions, onClose, onDone }: { lanes: readonly Lane[]; busy: boolean; actions?: EfficiencyActions; onClose: () => void; onDone: () => void }) {
  const t = useT('planning-params')
  const say = useSay()
  const [value, setValue] = useState('')
  const check = lanes[0] ? percentEdit({ ...lanes[0], effective: { ...lanes[0].effective, efficiencySource: 'SITE' } }, value) : null
  const problem = value.trim() && check?.kind === 'refused' ? say(check.words) : undefined
  return (
    <Modal
      open
      onClose={onClose}
      title={t('pp.efficiency.bulkTitle', { count: lanes.length })}
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>{t('pp.cancel')}</Button>
          <Button
            variant="primary"
            heldReason={busy ? t('pp.held.busy') : !value.trim() ? t('pp.efficiency.bulkNeeds') : problem ?? null}
            onClick={async () => {
              if (check?.kind !== 'write') return
              const ok = await (actions?.onBulkPct?.(lanes, check.value) ?? Promise.resolve(true))
              if (ok) {
                onDone()
                onClose()
              }
            }}
          >
            {busy ? <Spinner size={12} /> : null} {t('pp.efficiency.bulkApply', { count: lanes.length })}
          </Button>
        </>
      }
    >
      <div className="fw-pp-dialog">
        <Field label={t('pp.col.plannedEfficiencyPct')} hint={t('pp.efficiency.bulkHint')} error={problem}>
          <Input inputMode="decimal" suffix="%" value={value} onChange={(event) => setValue(event.target.value)} />
        </Field>
        <ul className="fw-pp-names">
          {lanes.map((lane) => (
            <li key={laneKey(lane)}>
              {lane.code} · {lane.name}
            </li>
          ))}
        </ul>
      </div>
    </Modal>
  )
}
