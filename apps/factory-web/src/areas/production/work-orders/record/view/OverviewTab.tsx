'use client'

import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle2, Circle, Pencil, XCircle } from 'lucide-react'
import { Banner, Card, Field, KeyValue, ProgressBar } from '@nexus/ui/components'
import { SizeGridEditor, SizeGridView } from '@nexus/ui/grid'
import { Button, Input, SegmentedControl, Spinner, Tag } from '@nexus/ui/primitives'
import { DateField } from '../../../../../lib/i18n/ds-parts'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import type { WorkOrder } from '../../../_shared/api'
import { sizeGridCopy } from '../../../_shared/grid-copy'
import { checkItems, draftGrid, gridChanged, mayEditDetails, onlyMaterialShort, percentOf, SIZE_LAYERS, sizeRunOf, stepTotals, type SizeLayer } from '../../../_shared/model'
import type { WorkOrderRecordActions, WorkOrderRecordModel } from '../record-model'
import { PartState } from './WorkOrderRecordView'
import { beforeRelease, readinessView } from '../../daily/model'
import { HoldsCard, ReadinessLine } from '../../daily/view/DailyParts'

/**
 * Overview & release (design wo-release, wo-frozen, wo-facts, wo-sizes-mini): a draft's release check (each condition
 * in words, the failed ones with what holds them), or what the release froze; the work order's facts with its due date
 * and priority (editable until closed); the size run with a layer at a time — quantity, cut, bundled, sewn, finished or
 * what is left — and the step totals; a draft's sizes edited here (saved together, never more than is open).
 */
export function OverviewTab({ workOrder, model, actions }: { workOrder: WorkOrder; model: WorkOrderRecordModel; actions?: WorkOrderRecordActions }) {
  return (
    <div className="fw-pr-stack">
      <div className="fw-pr-cards fw-pr-cards--wide">
        {beforeRelease(workOrder) ? <ReleaseCheckCard workOrder={workOrder} model={model} actions={actions} /> : <FrozenCard workOrder={workOrder} model={model} />}
        <FactsCard workOrder={workOrder} model={model} actions={actions} />
      </div>
      {/* B-W2a-46 (wo-side "holds (W2a)"): the work order's holds, Put on hold / Release the hold. */}
      {model.daily && <HoldsCard workOrder={workOrder} daily={model.daily} actions={actions?.daily} />}
      <SizeRunCard workOrder={workOrder} model={model} actions={actions} />
    </div>
  )
}

const STATE_ICON = {
  OK: <CheckCircle2 size={16} className="fw-pr-ico is-ok" aria-hidden />,
  NOT_REQUIRED: <Circle size={16} className="fw-pr-ico" aria-hidden />,
  OVERRIDDEN: <AlertTriangle size={16} className="fw-pr-ico is-overridden" aria-hidden />,
  BLOCKED: <XCircle size={16} className="fw-pr-ico is-blocked" aria-hidden />,
} as const

function ReleaseCheckCard({ workOrder, model, actions }: { workOrder: WorkOrder; model: WorkOrderRecordModel; actions?: WorkOrderRecordActions }) {
  const t = useT('production')
  const check = model.check.value
  if (!check) return <PartState label={t('overview.check')} problem={model.check.problem} onRetry={() => actions?.onRetryPart?.('check')} />
  const items = checkItems(check, workOrder)
  const open = items.filter((item) => item.state === 'BLOCKED').length
  return (
    <Card padded className="fw-pr-card">
      <div className="fw-pr-card-head">
        <h2 className="fw-pr-h2">{t('overview.check')}</h2>
        <Tag tone={open === 0 ? 'success' : onlyMaterialShort(check) ? 'warning' : 'danger'}>{open === 0 ? t('overview.ready') : t('overview.open', { count: open })}</Tag>
      </div>
      <ul className="fw-pr-checks" aria-label={t('overview.check')}>
        {items.map((item) => (
          <li key={item.code} className="fw-pr-check">
            {STATE_ICON[item.state]}
            <span className="fw-pr-check-body">
              <span>
                <b>{t(`check.name.${item.code}`)}</b> — {t(item.words.key, translateParams(t, item.words.params))}
              </span>
              {item.problems.length > 0 && (
                <ul className="fw-pr-check-problems">
                  {item.problems.map((problem, index) => (
                    <li key={index}>{t(problem.key, translateParams(t, problem.params))}</li>
                  ))}
                </ul>
              )}
            </span>
          </li>
        ))}
      </ul>
      {/* B-W2a-46 (wo-release "material available or expected (W2a readiness)"). */}
      <ReadinessLine readiness={check.readiness ?? null} />
      {onlyMaterialShort(check) && <p className="fw-pr-hint">{t('overview.overrideHint')}</p>}
      <p className="fw-pr-hint">{t('overview.notFrozen')}</p>
    </Card>
  )
}

/** Params whose value is itself a message key (`reason.CR_VI_PENDING`, `kind.SEWING`) are drawn in words. */
export function translateParams(t: (key: string, params?: Record<string, string | number>) => string, params?: Readonly<Record<string, string | number>>): Record<string, string | number> | undefined {
  if (!params) return undefined
  return Object.fromEntries(Object.entries(params).map(([name, value]) => [name, typeof value === 'string' && /^(reason|kind)\.[A-Z_]+$/.test(value) ? t(value) : value]))
}

function FrozenCard({ workOrder, model }: { workOrder: WorkOrder; model: WorkOrderRecordModel }) {
  const t = useT('production')
  const locale = useLocale()
  const override = workOrder.release?.materialOverride ?? null
  return (
    <Card padded className="fw-pr-card">
      <div className="fw-pr-card-head">
        <h2 className="fw-pr-h2">{t('overview.frozen')}</h2>
        {workOrder.spec.frozenAt && <span className="fw-pr-hint">{t('overview.frozenAt', { when: formatDateTime(workOrder.spec.frozenAt, { locale }) })}</span>}
      </div>
      <KeyValue
        columns={2}
        items={[
          { label: t('overview.revision'), value: workOrder.revision ? t('overview.revisionValue', { revision: workOrder.revision.revision }) : '—' },
          { label: t('overview.batch'), value: workOrder.batchNumber ?? '—', hint: t('overview.batchHint') },
          { label: t('overview.operations'), value: t('overview.operationsValue', { count: workOrder.spec.operations.length, minutes: workOrder.spec.standardMinutes.perGarment }) },
          { label: t('overview.materials'), value: t('overview.materialsValue', { count: workOrder.spec.materials.length }) },
          { label: t('overview.label'), value: workOrder.labelTemplate ? `${workOrder.labelTemplate.code} v${workOrder.labelTemplate.revision}` : '—' },
          { label: t('overview.minutesAll'), value: t('overview.minutes', { minutes: workOrder.spec.standardMinutes.allPieces }) },
        ]}
      />
      {override && <Banner tone="warning" title={t('overview.override', { reason: override.reason })} />}
      <ReadinessLine readiness={readinessView(workOrder, null, model.daily?.readiness?.value ?? null)} />
      <p className="fw-pr-hint">{t('overview.frozenHint')}</p>
    </Card>
  )
}

function FactsCard({ workOrder, model, actions }: { workOrder: WorkOrder; model: WorkOrderRecordModel; actions?: WorkOrderRecordActions }) {
  const t = useT('production')
  const locale = useLocale()
  const editable = mayEditDetails(workOrder, model.can)
  const [editing, setEditing] = useState(!!model.draft?.editing)
  const [dueDate, setDueDate] = useState(model.draft?.dueDate ?? workOrder.dueDate ?? '')
  const [priority, setPriority] = useState(model.draft?.priority ?? String(workOrder.priority))
  useEffect(() => {
    if (!editing) {
      setDueDate(workOrder.dueDate ?? '')
      setPriority(String(workOrder.priority))
    }
  }, [editing, workOrder.dueDate, workOrder.priority])
  const priorityValue = Number(priority)
  const priorityBad = priority.trim() === '' || !Number.isInteger(priorityValue) || priorityValue < -1000 || priorityValue > 1000
  const dirty = editing && (dueDate !== (workOrder.dueDate ?? '') || priority !== String(workOrder.priority))
  useEffect(() => actions?.onDirty?.('details', dirty), [dirty])
  const save = () => {
    if (priorityBad || !dirty || model.busy) return
    actions?.onSaveDetails?.({ dueDate: dueDate || null, priority: priorityValue })
    setEditing(false)
  }
  // ⌘S saves while editing.
  useEffect(() => {
    if (!editing) return
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        save()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
  const at = (value: string | null) => (value ? formatDateTime(value, { locale }) : '—')
  return (
    <Card padded className="fw-pr-card">
      <div className="fw-pr-card-head">
        <h2 className="fw-pr-h2">{t('overview.facts')}</h2>
        {!editing && (
          <Button size="sm" variant="quiet" heldReason={editable ? null : model.can.manage ? t('held.finished') : t('held.noManage')} onClick={() => setEditing(true)}>
            <Pencil size={13} aria-hidden /> {t('overview.edit')}
          </Button>
        )}
      </div>
      {editing ? (
        <div className="fw-pr-dialog">
          <Field label={t('overview.due')} hint={t('overview.dueHint')}>
            <DateField value={dueDate} onChange={setDueDate} clearable clearLabel={t('new.dueClear')} ariaLabel={t('overview.due')} />
          </Field>
          <Field label={t('overview.priority')} hint={t('overview.priorityHint')} error={priorityBad ? t('overview.priorityBad') : undefined}>
            <Input type="number" inputMode="numeric" value={priority} onChange={(event) => setPriority(event.target.value)} />
          </Field>
          <div className="fw-pr-actions">
            <Button size="sm" variant="primary" heldReason={priorityBad ? t('overview.priorityBad') : !dirty ? t('held.nothingChanged') : model.busy ? t('held.busy') : null} onClick={save} aria-keyshortcuts="Meta+S Control+S">
              {model.busy ? <Spinner size={12} /> : null} {t('common.save')}
            </Button>
            <Button size="sm" variant="quiet" onClick={() => setEditing(false)}>
              {t('common.discard')}
            </Button>
          </div>
        </div>
      ) : (
        <KeyValue
          columns={2}
          items={[
            { label: t('overview.style'), value: `${workOrder.style.code} · ${workOrder.style.name}`, hint: workOrder.revision ? t('overview.revisionValue', { revision: workOrder.revision.revision }) : t('overview.noRevision') },
            { label: t('overview.kind'), value: t(`kindOf.${workOrder.kind}`) },
            { label: t('overview.site'), value: `${workOrder.site.code} · ${workOrder.site.name}` },
            { label: t('overview.customers'), value: [...new Set(workOrder.orders.map((order) => order.partyName))].join(', ') || '—', hint: workOrder.orders.map((order) => order.number).join(' · ') },
            { label: t('overview.due'), value: workOrder.dueDate ? formatDate(`${workOrder.dueDate}T12:00:00Z`, { locale }) : '—', hint: workOrder.daysLate && workOrder.daysLate > 0 ? t('list.daysLate', { count: workOrder.daysLate }) : undefined },
            { label: t('overview.priority'), value: String(workOrder.priority) },
            { label: t('overview.released'), value: at(workOrder.release?.at ?? null) },
            { label: t('overview.started'), value: at(workOrder.startedAt) },
            { label: t('overview.completed'), value: at(workOrder.completedAt) },
            ...(workOrder.closedAt ? [{ label: t('overview.closedAt'), value: at(workOrder.closedAt) }] : []),
          ]}
        />
      )}
    </Card>
  )
}

function SizeRunCard({ workOrder, model, actions }: { workOrder: WorkOrder; model: WorkOrderRecordModel; actions?: WorkOrderRecordActions }) {
  const t = useT('production')
  const locale = useLocale()
  const copy = useMemo(() => sizeGridCopy(t), [t])
  const draft = workOrder.status === 'DRAFT'
  const layer: SizeLayer = draft ? 'quantity' : model.sizeLayer
  const run = sizeRunOf(workOrder, layer)
  const totals = stepTotals(workOrder)
  const [editing, setEditing] = useState(!!model.draft?.grid)
  const [grid, setGrid] = useState<Record<string, Record<string, number>>>(model.draft?.grid ?? draftGrid(workOrder))
  useEffect(() => {
    if (!editing) setGrid(draftGrid(workOrder))
  }, [editing, workOrder])
  const changed = editing && gridChanged(workOrder, grid)
  useEffect(() => actions?.onDirty?.('sizes', changed), [changed])
  const numberLocale = locale === 'it' ? 'it-IT' : 'en-GB'
  return (
    <Card padded className="fw-pr-card">
      <div className="fw-pr-card-head">
        <h2 className="fw-pr-h2">{t('size.title')}</h2>
        {draft ? (
          !editing && (
            <Button size="sm" variant="quiet" heldReason={model.can.manage ? null : t('held.noManage')} onClick={() => setEditing(true)}>
              <Pencil size={13} aria-hidden /> {t('size.edit')}
            </Button>
          )
        ) : (
          <SegmentedControl size="sm" wrap ariaLabel={t('size.layer')} value={layer} onChange={(value) => actions?.onSizeLayer?.(value as SizeLayer)} options={SIZE_LAYERS.map((value) => ({ value, label: t(`size.layers.${value}`) }))} />
        )}
      </div>
      {!draft && (
        <div className="fw-pr-steps">
          {(['cut', 'bundled', 'sewn', 'finished'] as const).map((step) => (
            <div key={step} className="fw-pr-step">
              <span className="fw-pr-step-label">{t(`size.layers.${step}`)}</span>
              <span className="fw-pr-step-value">{totals[step] === null ? t('size.notCounted') : t('size.ofTotal', { done: totals[step]!, total: workOrder.pieces })}</span>
              <ProgressBar value={percentOf(totals[step], workOrder.pieces)} height={6} ariaLabel={t(`size.layers.${step}`)} />
            </div>
          ))}
        </div>
      )}
      <div className="fw-pr-gridbox">
        {editing ? (
          <SizeGridEditor
            colours={run.colours}
            sizes={run.sizes}
            value={grid}
            onChange={setGrid}
            locale={numberLocale}
            copy={copy}
            caption={t('size.title')}
          />
        ) : (
          <SizeGridView colours={run.colours} sizes={run.sizes} value={run.value} locale={numberLocale} copy={copy} caption={t(`size.layers.${layer}`)} />
        )}
      </div>
      {editing && (
        <div className="fw-pr-actions">
          <Button
            size="sm"
            variant="primary"
            heldReason={!changed ? t('held.nothingChanged') : model.busy ? t('held.busy') : null}
            onClick={() => {
              actions?.onSaveSizes?.(grid)
              setEditing(false)
            }}
          >
            {model.busy ? <Spinner size={12} /> : null} {t('size.save')}
          </Button>
          <Button size="sm" variant="quiet" onClick={() => setEditing(false)}>
            {t('common.discard')}
          </Button>
          <span className="fw-pr-hint">{t('size.editHint')}</span>
        </div>
      )}
      {!draft && run.uncounted && <p className="fw-pr-hint">{t('size.uncounted')}</p>}
      {draft && !editing && <p className="fw-pr-hint">{t('size.draftHint')}</p>}
      {!draft && <p className="fw-pr-hint">{t('size.frozenHint')}</p>}
    </Card>
  )
}
