'use client'

import { useMemo, useRef, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Banner, Field, SummaryTable } from '@nexus/ui/components'
import { NexusGrid, SHEET_GRID_OPTIONS, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { sizeColumns } from '@nexus/ui/grid/size-columns/index'
import { Button, Input, Pill, SegmentedControl, Select, Tag } from '@nexus/ui/primitives'
import type { GradeFormat } from '@nexus/factory-domain/product/grading/rules'
import { DetailModal, useDsWords } from '../../../../../lib/i18n/ds-parts'
import { INTL_LOCALE } from '../../../../../lib/i18n/locales'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import type { RuleView } from '../api'
import { allowedRows, bothWays, droppedSteps, givenKeys, offsetsOf, ruleChanged, ruleHeld, signedText, STANDARD, stepColumns, stepEnds, stepKey, stepLabel, stepRowsOf, unitText, type DepthCan, type StepRow } from '../model'
import type { OpenRule, RulesActions } from './RulesView'
import { ProblemBanner } from './parts'

export interface RuleFields {
  name: string
  baseSize: string
  format: GradeFormat
}

/**
 * The Grade rule pop-up (B-W2b-240; design products.sizes pop:sizes.gradeRule, DetailModal "Increments per POM × size
 * step (SizeColumns)", Save, J / K): the rule's name, base size and how its increments count, then one row per point of
 * measure — its standard increment (every step) and each step between neighbour sizes of a fit (or from the base of an
 * absolute rule), typed or pasted as numbers (negative too; "—" uses the standard), a point added from the library or
 * taken out — and below, what the rule grades to from the base size (the domain's own grading: a size no step reaches
 * says so, never 0). Save sends the fields and every step at the rule's version. A reader sees the same as text.
 */
export function GradeRuleDialog({ open, ids, can, actions }: { open: OpenRule; ids: readonly string[]; can: DepthCan; actions?: RulesActions }) {
  const t = useT('products-sizes-depth')
  const rule = open.rule.status === 'ready' ? open.rule.value : null
  const nav = ids.includes(open.id) ? { ids, current: open.id, onGo: (id: string) => actions?.onOpen?.(id), noun: t('rules.noun') } : undefined
  const close = () => actions?.onOpen?.(null)
  if (!rule)
    return (
      <DetailModal
        open
        onClose={close}
        title={t('rules.dialog.title')}
        nav={nav}
        loading={open.rule.status === 'loading'}
        error={open.rule.status === 'error' ? t(open.rule.problem) : undefined}
        onRetry={() => actions?.onReadRule?.()}
      />
    )
  return <Ready key={`${rule.id}:${rule.version}`} rule={rule} open={open} nav={nav} can={can} actions={actions} />
}

function Ready({ rule, open, nav, can, actions }: { rule: RuleView; open: OpenRule; nav: { ids: readonly string[]; current: string; onGo: (id: string) => void; noun: string } | undefined; can: DepthCan; actions?: RulesActions }) {
  const t = useT('products-sizes-depth')
  const locale = useLocale()
  const ds = useDsWords()
  const [fields, setFields] = useState<RuleFields>(() => open.preset?.fields ?? { name: rule.name, baseSize: rule.baseSize, format: rule.format })
  const [rows, setRows] = useState<StepRow[]>(() => open.preset?.rows ?? stepRowsOf(rule))
  const [extra, setExtra] = useState<string[]>([])
  const [addPoint, setAddPoint] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const held = ruleHeld(rule, can.manage)
  const editable = held === null
  const latest = useRef({ rows, editable })
  latest.current = { rows, editable }
  const sizes = rule.sizes
  const active = sizes.filter((size) => size.status !== 'ARCHIVED')
  const keys = stepColumns(fields.format, fields.baseSize, sizes, [...givenKeys(allowedRows(rows, fields.format, fields.baseSize)), ...extra.filter((key) => fields.format !== 'ABSOLUTE' || stepEnds(key)?.[0] === fields.baseSize)])
  const dropped = droppedSteps(rows, fields.format, fields.baseSize)
  const changed = ruleChanged(rule, fields, rows)
  const twoWays = bothWays(allowedRows(rows, fields.format, fields.baseSize))
  const busy = open.busy
  const nameMissing = fields.name.trim() === ''
  const saveHeld = held ? t(held) : nameMissing ? t('rules.problem.name') : twoWays ? t('rules.problem.bothWays', { code: twoWays.code, from: twoWays.from, to: twoWays.to }) : !changed.fields && !changed.steps ? t('held.nothing') : busy ? t('held.busy') : null
  const intl = INTL_LOCALE[locale]

  const setCell = (pointId: string, key: string, value: string | null) =>
    setRows((current) => current.map((row) => (row.pointOfMeasureId !== pointId ? row : key === STANDARD ? { ...row, standard: value } : { ...row, steps: { ...row.steps, [key]: value } })))

  const columns = useMemo<ColDef<StepRow>[]>(() => {
    const PointCell = ({ data }: ICellRendererParams<StepRow>) =>
      data ? (
        <span className="fw-szd-cell">
          <b>{data.code}</b>
          <span className="fw-szd-sub">
            {data.name} · {unitText(data.uom)}
            {data.status === 'ARCHIVED' ? ` · ${t('status.ARCHIVED')}` : ''}
          </span>
        </span>
      ) : null
    const standard = sizeColumns<StepRow>({
      sizes: [STANDARD],
      value: (row) => row.standard,
      editable: () => latest.current.editable,
      required: false,
      negative: true,
      scale: 2,
      onChange: (row, _size, value) => setCell(row.pointOfMeasureId, STANDARD, value),
      locale: intl,
      colIdPrefix: 'standard:',
      width: 120,
      cellLabel: (row) => t('rules.grid.standardCell', { code: row.code }),
      labels: ds.sizeColumns,
    }).map((column) => ({
      ...column,
      headerName: t('rules.grid.standard'),
      headerTooltip: t('rules.grid.standardTip'),
      // The cell names its step in words, never the column's key.
      tooltipValueGetter: (params: { data?: StepRow | null; valueFormatted?: string | null }) => (params.data ? ds.sizeColumns.cellTooltip(t('rules.grid.standard'), params.data.standard === null ? null : (params.valueFormatted ?? null), null, false) : undefined),
    }))
    const steps = sizeColumns<StepRow>({
      sizes: keys,
      value: (row, key) => row.steps[key] ?? null,
      editable: () => latest.current.editable,
      required: false,
      negative: true,
      scale: 2,
      onChange: (row, key, value) => setCell(row.pointOfMeasureId, key, value),
      locale: intl,
      colIdPrefix: 'step:',
      cellLabel: (row, key) => t('rules.grid.stepCell', { code: row.code, step: stepLabel(key) }),
      labels: ds.sizeColumns,
    }).map((column) => {
      const key = (column.colId ?? '').replace(/^step:/, '')
      return {
        ...column,
        headerName: stepLabel(key),
        headerTooltip: t(fields.format === 'ABSOLUTE' ? 'rules.grid.fromBaseTip' : 'rules.grid.stepTip', { step: stepLabel(key) }),
        tooltipValueGetter: (params: { data?: StepRow | null; valueFormatted?: string | null }) => (params.data ? ds.sizeColumns.cellTooltip(stepLabel(key), (params.data.steps[key] ?? null) === null ? null : (params.valueFormatted ?? null), null, false) : undefined),
      }
    })
    const RemoveCell = ({ data }: ICellRendererParams<StepRow>) =>
      data && latest.current.editable ? (
        <Button size="xs" variant="quiet" aria-label={t('rules.grid.remove', { code: data.code })} onClick={() => setRows((current) => current.filter((row) => row.pointOfMeasureId !== data.pointOfMeasureId))}>
          <Trash2 size={13} aria-hidden />
        </Button>
      ) : null
    return [
      { colId: 'point', headerName: t('rules.grid.point'), pinned: 'left', minWidth: 190, flex: 1.4, sortable: false, suppressHeaderMenuButton: true, valueGetter: (params) => params.data?.code ?? '', cellRenderer: PointCell },
      ...standard,
      ...steps,
      ...(editable ? [{ colId: 'remove', headerName: '', minWidth: 56, maxWidth: 56, pinned: 'right' as const, sortable: false, suppressHeaderMenuButton: true, cellRenderer: RemoveCell }] : []),
    ]
  }, [t, intl, ds.sizeColumns, keys.join(','), fields.format, editable])

  const choices = (open.points ?? []).filter((point) => !rows.some((row) => row.pointOfMeasureId === point.id))
  const stepProblem = from === '' || to === '' ? 'rules.add.pick' : from === to ? 'rules.add.same' : keys.includes(stepKey(from, to)) ? 'rules.add.there' : null
  const save = () => {
    if (!saveHeld) void actions?.onSaveRule?.(rule, fields, allowedRows(rows, fields.format, fields.baseSize))
  }

  return (
    <DetailModal
      open
      onClose={() => actions?.onOpen?.(null)}
      title={
        <span>
          {rule.code} <span className="fw-szd-sub">· {rule.name}</span>
        </span>
      }
      subtitle={t('rules.dialog.subtitle', { scale: `${rule.scale.code} · ${rule.scale.name}`, base: rule.baseSize, format: t(`format.${rule.format}`) })}
      meta={
        <span className="fw-szd-inline">
          <Pill tone={rule.status === 'ACTIVE' ? 'success' : 'neutral'}>{t(`status.${rule.status}`)}</Pill>
          {rule.scale.dimensions === 2 && <Tag tone="info">{t('rules.twoDimensions')}</Tag>}
          <Tag tone="neutral">{t('rules.specs', { count: rule.specs })}</Tag>
        </span>
      }
      nav={nav}
      footer={
        <>
          <Button onClick={() => actions?.onOpen?.(null)}>{t('common.close')}</Button>
          {editable && (
            <Button variant="primary" heldReason={saveHeld} onClick={save} aria-keyshortcuts="Meta+Enter Control+Enter">
              {t('common.save')}
            </Button>
          )}
        </>
      }
    >
      <div
        className="fw-szd-dialog"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            save()
          }
        }}
      >
        {held && <Banner tone="info" title={t(held === 'held.noManage' ? 'rules.readOnly' : held)} />}
        {open.refused && <ProblemBanner problem={open.refused} onReload={() => actions?.onReadRule?.()} />}
        <div className="fw-szd-form">
          <Field label={t('rules.field.name')} required error={nameMissing ? t('rules.problem.name') : undefined}>
            <Input value={fields.name} maxLength={200} readOnly={!editable} onChange={(event) => setFields((current) => ({ ...current, name: event.target.value }))} />
          </Field>
          <Field label={t('rules.field.base')} hint={t('rules.field.baseHint')}>
            <Select value={fields.baseSize} disabled={!editable} onChange={(event) => setFields((current) => ({ ...current, baseSize: event.target.value }))}>
              {active.map((size) => (
                <option key={size.code} value={size.code}>
                  {size.label ? `${size.code} · ${size.label}` : size.code}
                </option>
              ))}
            </Select>
          </Field>
          <div className="fw-szd-span">
            <Field label={t('rules.field.format')} hint={t(`format.hint.${fields.format}`)}>
              {editable ? (
                <SegmentedControl ariaLabel={t('rules.field.format')} size="sm" value={fields.format} onChange={(value) => setFields((current) => ({ ...current, format: value as GradeFormat }))} options={[{ value: 'RELATIVE', label: t('format.RELATIVE') }, { value: 'ABSOLUTE', label: t('format.ABSOLUTE') }]} />
              ) : (
                <span>{t(`format.${fields.format}`)}</span>
              )}
            </Field>
          </div>
        </div>
        {dropped > 0 && <Banner tone="warning" title={t('rules.dropped', { count: dropped, base: fields.baseSize })} />}
        <h3 className="fw-szd-h3">{t('rules.grid.title')}</h3>
        <p className="fw-szd-sub">{t(fields.format === 'ABSOLUTE' ? 'rules.grid.introAbsolute' : 'rules.grid.introRelative')}</p>
        {rows.length === 0 ? (
          <p className="fw-szd-sub">{t('rules.grid.empty')}</p>
        ) : (
          <div className="fw-szd-grid" role="region" aria-label={t('rules.grid.title')}>
            <NexusGrid<StepRow> {...SHEET_GRID_OPTIONS} rowData={rows} columnDefs={columns} getRowId={(params) => params.data.pointOfMeasureId} cellSelection domLayout="autoHeight" />
          </div>
        )}
        {editable && (
          <div className="fw-szd-adders">
            <div className="fw-szd-inline">
              <Select size="sm" aria-label={t('rules.add.point')} value={addPoint} disabled={open.points === null} onChange={(event) => setAddPoint(event.target.value)}>
                <option value="">{open.points === null ? t('common.reading') : choices.length === 0 ? t('rules.add.noPoint') : t('rules.add.point')}</option>
                {choices.map((point) => (
                  <option key={point.id} value={point.id}>
                    {`${point.code} · ${point.name}`}
                  </option>
                ))}
              </Select>
              <Button
                size="sm"
                heldReason={addPoint ? null : t('rules.add.pickPoint')}
                onClick={() => {
                  const point = choices.find((entry) => entry.id === addPoint)
                  if (!point) return
                  setRows((current) => [...current, { pointOfMeasureId: point.id, code: point.code, name: point.name, uom: point.uom, status: 'ACTIVE', standard: null, steps: {} }])
                  setAddPoint('')
                }}
              >
                <Plus size={13} aria-hidden /> {t('rules.add.pointButton')}
              </Button>
            </div>
            {fields.format === 'RELATIVE' && (
              <div className="fw-szd-inline">
                <span className="fw-szd-sub">{t('rules.add.stepLead')}</span>
                <Select size="sm" aria-label={t('rules.add.from')} value={from} onChange={(event) => setFrom(event.target.value)}>
                  <option value="">{t('rules.add.from')}</option>
                  {active.map((size) => (
                    <option key={size.code} value={size.code}>
                      {size.code}
                    </option>
                  ))}
                </Select>
                <Select size="sm" aria-label={t('rules.add.to')} value={to} onChange={(event) => setTo(event.target.value)}>
                  <option value="">{t('rules.add.to')}</option>
                  {active.map((size) => (
                    <option key={size.code} value={size.code}>
                      {size.code}
                    </option>
                  ))}
                </Select>
                <Button
                  size="sm"
                  heldReason={stepProblem ? t(stepProblem) : null}
                  onClick={() => {
                    setExtra((current) => [...current, stepKey(from, to)])
                    setFrom('')
                    setTo('')
                  }}
                >
                  <Plus size={13} aria-hidden /> {t('rules.add.stepButton')}
                </Button>
              </div>
            )}
          </div>
        )}
        {rows.length > 0 && (
          <section className="fw-szd-stack" aria-label={t('rules.grades.title')}>
            <h3 className="fw-szd-h3">{t('rules.grades.title')}</h3>
            <p className="fw-szd-sub">{t('rules.grades.intro', { base: fields.baseSize })}</p>
            <SummaryTable
              label={t('rules.grades.title')}
              stackOnPhone
              columns={[t('rules.grid.point'), ...active.map((size) => (size.code === fields.baseSize ? t('rules.grades.base', { size: size.code }) : size.code))]}
              align={['left', ...active.map(() => 'right' as const)]}
              rows={rows.map((row) => {
                const offsets = offsetsOf(row, fields, sizes)
                return {
                  id: row.pointOfMeasureId,
                  cells: [
                    <b key="p">{row.code}</b>,
                    ...active.map((size) => {
                      const offset = offsets[size.code] ?? null
                      return offset === null ? (
                        <span key={size.code} className="fw-szd-warn" title={t('rules.grades.notReached')}>
                          {t('rules.grades.none')}
                        </span>
                      ) : (
                        <span key={size.code}>{signedText(offset, locale)}</span>
                      )
                    }),
                  ],
                }
              })}
            />
          </section>
        )}
      </div>
    </DetailModal>
  )
}
