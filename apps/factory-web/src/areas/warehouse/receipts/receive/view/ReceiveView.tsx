'use client'

import { useEffect, useMemo, useRef, type ClipboardEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import Link from 'next/link'
import { AlertTriangle, CheckCircle2, PackageCheck, Plus, ShieldOff, Trash2, XCircle } from 'lucide-react'
import { HIDE_AREA_UNITS } from '@nexus/factory-domain/inventory/receipts/rules'
import { Banner, Card, EmptyState, Field, KeyValue } from '@nexus/ui/components'
import type { ColDef, ICellRendererParams } from '@nexus/ui/grid'
import { DetailHeader } from '@nexus/ui/patterns'
import { Button, Checkbox, Input, Kbd, Pill, Select, Spinner, Tag } from '@nexus/ui/primitives'
import { DateField, Textarea } from '../../../../../lib/i18n/ds-parts'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { dayAt, quantity } from '../../../../_shared/buying/model'
import type { ExpectedLine, Uom } from '../../api'
import {
  blankHide,
  blankLot,
  expectedByOrder,
  HIDE_COLUMNS,
  hideCounts,
  lineBase,
  lineDiff,
  pasteHides,
  postHeld,
  receiveChecks,
  type HideColumn,
  type HideDraft,
  type LotDraft,
  type ReceiveActions,
  type ReceiveDraft,
  type ReceiveLineDraft,
  type ReceiveModel,
} from '../../model'
import '../../../../_shared/buying/buying.css'

export type { ReceiveActions, ReceiveModel } from '../../model'

const dateLocale = (locale: string) => (locale === 'it' ? 'it-IT' : 'en-GB')

/**
 * Receive goods against a purchase order (SCR-063's New receipt, with SCR-061 the hides one by one and SCR-062 the lots
 * and their quality hold): pick the order (the orders that take goods now), then one card per open order line — what it
 * expects, has received and still waits for, with its tolerance — and, by the material's tracking: leather in lots of
 * hides typed one by one (tannery number, measured area in m², dm² or ft², grade, thickness, shade, defects; Enter goes
 * down, Tab right, a column pasted from a spreadsheet fills down), a lot-tracked material in lots with a quantity,
 * anything else a quantity. A lot may be held for a quality check with a reason (lots that need a chromium VI test or a
 * PPE certificate start in quarantine by themselves). Beside it: Ready to post in words, the running totals against the
 * tolerance, and Post receipt (⌘↵) — the receipt and its lots take their numbers from the series when it is posted.
 */
export function ReceiveView({ model, actions }: { model: ReceiveModel; actions?: ReceiveActions }) {
  return (
    <WithMessages namespaces={['buying', 'lists']}>
      <Receive model={model} actions={actions} />
    </WithMessages>
  )
}

function Receive({ model, actions }: { model: ReceiveModel; actions?: ReceiveActions }) {
  const t = useT('buying')
  const listHref = `${model.prefix}/warehouse/receipts`
  const draft = model.draft
  const checks = useMemo(() => (draft ? receiveChecks(draft) : []), [draft])
  const held = postHeld(checks)
  const order = draft ? (draft.lines[0]?.line ?? null) : null

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && draft && !held && !model.posting && !model.result) {
        event.preventDefault()
        actions?.onPost?.()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (!model.can.receive) {
    return (
      <div className="fw-by">
        <div className="fw-by-band">
          <DetailHeader backAsChild backLabel={<Link href={listHref}>{t('rc.back')}</Link>} title={t('rc.receive.title')} />
        </div>
        <Card padded>
          <EmptyState icon={<ShieldOff size={24} aria-hidden />} title={t('rc.receive.noAccess.title')} description={t('rc.receive.noAccess.body')} />
        </Card>
      </div>
    )
  }

  const title = order ? (
    <span className="fw-by-title">
      {t('rc.receive.title')} <span className="fw-by-title-sub">· {order.number} · {order.supplier.name}</span>
    </span>
  ) : (
    t('rc.receive.title')
  )
  const postButton = draft && !model.result && (
    <Button size="sm" variant="primary" heldReason={model.posting ? t('held.busy') : held ? t(held.key, held.params) : null} onClick={() => actions?.onPost?.()} aria-keyshortcuts="Meta+Enter Control+Enter">
      {model.posting ? <Spinner size={12} /> : <PackageCheck size={14} aria-hidden />} {t('rc.receive.post')}
      <span className="fw-by-keys" aria-hidden>
        <Kbd>⌘</Kbd>
        <Kbd>↵</Kbd>
      </span>
    </Button>
  )

  return (
    <div className="fw-by">
      <div className="fw-by-band">
        <DetailHeader backAsChild backLabel={<Link href={listHref}>{t('rc.back')}</Link>} title={title} actions={postButton || undefined} />
        {order && !model.result && <p className="fw-by-hint">{t('rc.receive.intro', { status: t(`poStatus.${order.status}`) })}</p>}
      </div>
      {model.result ? <Result model={model} actions={actions} /> : draft ? <Form draft={draft} model={model} actions={actions} /> : <PickOrder model={model} actions={actions} />}
    </div>
  )
}

/** No order yet: the orders that take goods now, one row each. */
function PickOrder({ model, actions }: { model: ReceiveModel; actions?: ReceiveActions }) {
  const t = useT('buying')
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const orders = model.orders.status === 'ready' ? expectedByOrder(model.orders.value) : null
  type Row = NonNullable<typeof orders>[number]
  const columns: ColDef<Row>[] = [
    {
      colId: 'order',
      headerName: t('rc.col.order'),
      minWidth: 170,
      flex: 1,
      cellRenderer: ({ data }: ICellRendererParams<Row>) =>
        data ? (
          <span className="fw-by-cell">
            <Link className="fw-by-link" href={`${model.prefix}/purchasing/orders/${data.purchaseOrderId}`}>
              {data.number}
            </Link>
            <span className="fw-by-cell-sub">{t(`poStatus.${data.lines[0]!.status}`)}</span>
          </span>
        ) : null,
    },
    { colId: 'supplier', headerName: t('rc.col.supplier'), field: 'supplier', minWidth: 180, flex: 1.4 },
    { colId: 'lines', headerName: t('rc.col.openLines'), minWidth: 120, flex: 0.6, valueGetter: (params) => (params.data ? t('rc.receive.openLines', { count: params.data.lines.length }) : '') },
    { colId: 'materials', headerName: t('rc.col.material'), minWidth: 220, flex: 1.8, valueGetter: (params) => (params.data ? params.data.lines.map((line) => line.item.code).join(' · ') : '') },
    { colId: 'due', headerName: t('rc.col.due'), minWidth: 110, flex: 0.7, valueGetter: (params) => (params.data ? formatDate(dayAt(params.data.lines.map((line) => line.needDate).sort()[0]!), place) : '') },
    {
      colId: 'receive',
      headerName: t('rc.col.receive'),
      minWidth: 120,
      maxWidth: 130,
      pinned: 'right',
      sortable: false,
      cellRenderer: ({ data }: ICellRendererParams<Row>) =>
        data ? (
          <Button size="sm" variant="primary" onClick={() => actions?.onPickOrder?.(data.purchaseOrderId)} aria-label={t('rc.receive.pickOrder', { number: data.number })}>
            <PackageCheck size={13} aria-hidden /> {t('rc.receiveShort')}
          </Button>
        ) : null,
    },
  ]
  return (
    <div className="fw-by-stack">
      <p className="fw-by-hint">{t('rc.receive.pickIntro')}</p>
      <ListFrame<Row>
        label={t('rc.receive.ordersLabel')}
        rows={model.orders.status === 'ready' ? orders : model.orders.status === 'loading' ? null : []}
        rowId={(row) => row.purchaseOrderId}
        columns={columns}
        count={orders ? t('rc.receive.ordersCount', { count: orders.length }) : '—'}
        onOpen={(row) => actions?.onPickOrder?.(row.purchaseOrderId)}
        state={
          model.orders.status === 'error' ? (
            <EmptyState title={t('rc.expected.failed')} description={t(model.orders.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('common.retry')}</Button>} />
          ) : orders && orders.length === 0 ? (
            <EmptyState title={t('rc.expected.empty.title')} description={t('rc.expected.empty.body')} />
          ) : undefined
        }
      />
    </div>
  )
}

function Form({ draft, model, actions }: { draft: ReceiveDraft; model: ReceiveModel; actions?: ReceiveActions }) {
  const t = useT('buying')
  const locale = useLocale()
  const checks = receiveChecks(draft)
  const set = (patch: Partial<ReceiveDraft>) => actions?.onChange?.({ ...draft, ...patch })
  const setLine = (index: number, next: ReceiveLineDraft) => set({ lines: draft.lines.map((entry, at) => (at === index ? next : entry)) })
  const included = draft.lines.filter((entry) => entry.include)
  const totals = new Map<Uom, number>()
  for (const entry of included) totals.set(entry.line.item.baseUom, (totals.get(entry.line.item.baseUom) ?? 0) + Number(lineBase(entry).toFixed(4)))
  const hides = included.reduce((sum, entry) => sum + hideCounts(entry).rows, 0)
  const lots = included.reduce((sum, entry) => sum + entry.lots.length, 0)
  const quarantined = included.filter((entry) => entry.line.requiresCrViTest || entry.lots.some((lot) => lot.hold)).length

  return (
    <div className="fw-by-two">
      <div className="fw-by-stack">
        <Card padded>
          <div className="fw-by-stack">
            <h2 className="fw-by-h2">{t('rc.receive.delivery')}</h2>
            <div className="fw-by-fields">
              <Field label={t('rc.receive.ddtNumber')} hint={t('rc.receive.ddtHint')}>
                <Input size="sm" value={draft.ddtNumber} maxLength={60} onChange={(event) => set({ ddtNumber: event.target.value })} autoFocus />
              </Field>
              <Field label={t('rc.receive.ddtDate')}>
                <DateField value={draft.ddtDate} onChange={(value) => set({ ddtDate: value })} locale={dateLocale(locale)} max={model.today} clearable clearLabel={t('common.clear')} />
              </Field>
              <Field label={t('rc.receive.receivedAt')} hint={t('rc.receive.receivedAtHint')}>
                <Input size="sm" type="datetime-local" value={draft.receivedAt} onChange={(event) => set({ receivedAt: event.target.value })} />
              </Field>
              <Field label={t('rc.receive.note')}>
                <Input size="sm" maxLength={1000} value={draft.note} onChange={(event) => set({ note: event.target.value })} />
              </Field>
            </div>
          </div>
        </Card>
        {draft.lines.map((entry, index) => (
          <LineCard key={entry.line.purchaseOrderLineId} entry={entry} onChange={(next) => setLine(index, next)} />
        ))}
      </div>

      <div className="fw-by-stack fw-by-sticky">
        <Card padded>
          <div className="fw-by-stack">
            <h2 className="fw-by-h2">{t('rc.receive.ready')}</h2>
            <ul className="fw-by-checks" aria-live="polite">
              {checks.map((check) => (
                <li key={check.id} className="fw-by-check">
                  {check.state === 'ok' ? <CheckCircle2 size={16} className="fw-by-ico is-ok" aria-hidden /> : check.state === 'blocked' ? <XCircle size={16} className="fw-by-ico is-blocked" aria-hidden /> : <AlertTriangle size={16} className="fw-by-ico is-warning" aria-hidden />}
                  <span className="fw-by-check-body">{t(check.words.key, check.words.params)}</span>
                </li>
              ))}
            </ul>
          </div>
        </Card>
        <Card padded>
          <div className="fw-by-stack">
            <h2 className="fw-by-h2">{t('rc.receive.totals')}</h2>
            <KeyValue
              dense
              labelCase="sentence"
              items={[
                { label: t('rc.receive.totalQuantity'), value: [...totals].map(([uom, total]) => `${quantity(total, locale)} ${t(`uom.${uom}`)}`).join(' · ') || '—' },
                { label: t('rc.receive.totalLots'), value: String(lots) },
                { label: t('rc.receive.totalHides'), value: String(hides) },
              ]}
            />
            <ul className="fw-by-list">
              <li>{t('rc.receive.numbers')}</li>
              <li>{quarantined > 0 ? t('rc.receive.quarantine', { count: quarantined }) : t('rc.receive.released')}</li>
              <li>{t('rc.receive.dock')}</li>
            </ul>
          </div>
        </Card>
        {model.problem && <Banner tone="danger" title={t(model.problem.key, model.problem.params)} />}
      </div>
    </div>
  )
}

function LineCard({ entry, onChange }: { entry: ReceiveLineDraft; onChange: (next: ReceiveLineDraft) => void }) {
  const t = useT('buying')
  const locale = useLocale()
  const { line } = entry
  const base = t(`uom.${line.item.baseUom}`)
  const diff = lineDiff(entry)
  const receiving = Number(diff.receiving)
  const setLot = (index: number, next: LotDraft) => onChange({ ...entry, lots: entry.lots.map((lot, at) => (at === index ? next : lot)) })
  const diffTone = diff.kind === 'OVER' ? 'danger' : diff.kind === 'SHORT' ? 'warning' : 'success'

  return (
    <Card padded>
      <div className="fw-by-stack">
        <div className="fw-by-card-head">
          <h3 className="fw-by-h3">
            <Checkbox checked={entry.include} onChange={(event) => onChange({ ...entry, include: event.target.checked })} label={t('rc.receive.lineTitle', { seq: line.seq, code: line.item.code, name: line.item.name })} />
          </h3>
          <span className="fw-by-meta">
            {line.colour && <Tag tone="neutral">{`${line.colour.code} ${line.colour.name}`}</Tag>}
            <Tag tone="info">{t(`rc.tracking.${line.item.tracking}`)}</Tag>
            {line.requiresCrViTest && <Tag tone="warning">{t('plan.crVi')}</Tag>}
            {line.oneDyeBatch && line.item.tracking === 'HIDE' && <Tag tone="neutral">{t('po.spec.oneDyeBatch')}</Tag>}
          </span>
        </div>
        <p className="fw-by-hint">
          {t('rc.receive.expects', {
            expected: quantity(line.expected, locale),
            received: quantity(line.received, locale),
            open: quantity(line.open, locale),
            unit: base,
          })}{' '}
          {line.tolerancePct ? t('rc.receive.upTo', { pct: line.tolerancePct, upTo: quantity(diff.upTo, locale), unit: base }) : t('rc.noTolerance')}
          {line.estimatedHides !== null ? ` · ${t('plan.hides', { count: line.estimatedHides })}` : ''}
        </p>
        {entry.include && (
          <>
            {line.item.tracking === 'HIDE' &&
              entry.lots.map((lot, index) => (
                <LotBox key={lot.key} line={line} lot={lot} index={index} count={entry.lots.length} onChange={(next) => setLot(index, next)} onRemove={() => onChange({ ...entry, lots: entry.lots.filter((_, at) => at !== index) })} />
              ))}
            {line.item.tracking === 'LOT' &&
              entry.lots.map((lot, index) => (
                <LotBox key={lot.key} line={line} lot={lot} index={index} count={entry.lots.length} onChange={(next) => setLot(index, next)} onRemove={() => onChange({ ...entry, lots: entry.lots.filter((_, at) => at !== index) })} />
              ))}
            {(line.item.tracking === 'HIDE' || line.item.tracking === 'LOT') && (
              <div className="fw-by-inline">
                <Button size="sm" onClick={() => onChange({ ...entry, lots: [...entry.lots, blankLot(line)] })}>
                  <Plus size={13} aria-hidden /> {t(line.item.tracking === 'HIDE' ? 'rc.receive.addDyeLot' : 'rc.receive.addLot')}
                </Button>
              </div>
            )}
            {(line.item.tracking === 'NONE' || line.item.tracking === 'SERIAL') && (
              <div className="fw-by-fields">
                <Field label={t('rc.receive.quantity', { unit: t(`uom.${line.uom}`) })} required>
                  <Input size="sm" inputMode="decimal" value={entry.quantity} onChange={(event) => onChange({ ...entry, quantity: event.target.value })} />
                </Field>
              </div>
            )}
            <div className="fw-by-totals" aria-live="polite">
              <Pill tone={receiving > 0 ? diffTone : 'neutral'}>{receiving > 0 ? t(`rc.diff.${diff.kind}`) : t('rc.diff.nothing')}</Pill>
              <span className="fw-by-num">{t('rc.receive.receiving', { quantity: quantity(diff.receiving, locale), unit: base })}</span>
              {receiving > 0 && <span className="fw-by-hint">{t(`rc.diffWords.${diff.kind}`, { after: quantity(diff.after, locale), expected: quantity(diff.expected, locale), open: quantity(diff.open, locale), more: quantity(diff.difference, locale), upTo: quantity(diff.upTo, locale), unit: base })}</span>}
            </div>
            {diff.kind === 'OVER' && receiving > 0 && (
              <Field label={t('rc.receive.overReason')} required hint={t('rc.receive.overHint')}>
                <Textarea rows={2} maxLength={500} value={entry.differenceReason} onChange={(event) => onChange({ ...entry, differenceReason: event.target.value })} />
              </Field>
            )}
            <Field label={t('rc.receive.lineNote')}>
              <Input size="sm" value={entry.note} maxLength={500} onChange={(event) => onChange({ ...entry, note: event.target.value })} />
            </Field>
          </>
        )}
      </div>
    </Card>
  )
}

function LotBox({ line, lot, index, count, onChange, onRemove }: { line: ExpectedLine; lot: LotDraft; index: number; count: number; onChange: (next: LotDraft) => void; onRemove: () => void }) {
  const t = useT('buying')
  const set = (patch: Partial<LotDraft>) => onChange({ ...lot, ...patch })
  const leather = line.item.tracking === 'HIDE'
  return (
    <fieldset className="fw-by-lot">
      <div className="fw-by-card-head">
        <legend className="fw-by-h3">{t(leather ? 'rc.receive.dyeLot' : 'rc.receive.lot', { n: index + 1 })}</legend>
        {count > 1 && (
          <Button size="sm" variant="quiet" onClick={onRemove} aria-label={t('rc.receive.removeLot', { n: index + 1 })}>
            <Trash2 size={13} aria-hidden /> {t('rc.receive.removeLotShort')}
          </Button>
        )}
      </div>
      <div className="fw-by-fields">
        <Field label={t('rc.receive.supplierLot')}>
          <Input size="sm" value={lot.supplierLotRef} maxLength={60} onChange={(event) => set({ supplierLotRef: event.target.value })} />
        </Field>
        {leather && (
          <Field label={t('rc.receive.dyeBatch')}>
            <Input size="sm" value={lot.dyeBatch} maxLength={60} onChange={(event) => set({ dyeBatch: event.target.value })} />
          </Field>
        )}
        <Field label={t('rc.receive.shade')}>
          <Input size="sm" value={lot.shade} maxLength={60} onChange={(event) => set({ shade: event.target.value })} />
        </Field>
        {!leather && (
          <Field label={t('rc.receive.lotQuantity', { unit: t(`uom.${line.uom}`) })} required>
            <Input size="sm" inputMode="decimal" value={lot.quantity} onChange={(event) => set({ quantity: event.target.value })} />
          </Field>
        )}
      </div>
      <Checkbox checked={lot.hold} onChange={(event) => set({ hold: event.target.checked })} label={t('rc.receive.hold')} />
      {lot.hold && (
        <Field label={t('rc.receive.holdReason')} required hint={t('rc.receive.holdHint')}>
          <Input size="sm" value={lot.holdReason} maxLength={500} onChange={(event) => set({ holdReason: event.target.value })} />
        </Field>
      )}
      {leather && <HideSheet line={line} lot={lot} onChange={(hides) => set({ hides })} lotIndex={index} />}
    </fieldset>
  )
}

/**
 * The hide entry sheet (a composed part: the DS has no keyboard entry grid — named in the report): one row per hide,
 * typed fast. Enter goes to the same field of the next hide (a new row at the end), Tab to the next field, a column
 * pasted from a spreadsheet fills the hides down from the cell. The running totals sit under it.
 */
function HideSheet({ line, lot, onChange, lotIndex }: { line: ExpectedLine; lot: LotDraft; onChange: (hides: HideDraft[]) => void; lotIndex: number }) {
  const t = useT('buying')
  const locale = useLocale()
  const box = useRef<HTMLDivElement>(null)
  const pending = useRef<{ row: number; column: HideColumn } | null>(null)
  const unit = lot.hides[lot.hides.length - 1]?.areaUom ?? blankHide(line).areaUom

  useEffect(() => {
    const want = pending.current
    if (!want) return
    pending.current = null
    box.current?.querySelector<HTMLInputElement>(`[data-row="${want.row}"][data-col="${want.column}"]`)?.focus()
  })

  const setHide = (row: number, patch: Partial<HideDraft>) => onChange(lot.hides.map((hide, at) => (at === row ? { ...hide, ...patch } : hide)))
  const onKey = (event: ReactKeyboardEvent<HTMLInputElement>, row: number, column: HideColumn) => {
    if (event.key !== 'Enter' || event.metaKey || event.ctrlKey) return
    event.preventDefault()
    const next = event.shiftKey ? row - 1 : row + 1
    if (next < 0) return
    if (next >= lot.hides.length) onChange([...lot.hides, blankHide(line, unit)])
    pending.current = { row: next, column }
  }
  const onPaste = (event: ClipboardEvent<HTMLInputElement>, row: number, column: HideColumn) => {
    const text = event.clipboardData.getData('text')
    if (!text.includes('\n') && !text.includes('\t')) return
    event.preventDefault()
    onChange(pasteHides(lot.hides, row, column, text, () => blankHide(line, unit)))
  }
  const cell = (hide: HideDraft, row: number, column: HideColumn, label: string, extra: { inputMode?: 'decimal'; maxLength?: number } = {}) => (
    <Input
      size="sm"
      value={hide[column]}
      aria-label={t('rc.sheet.cell', { field: label, n: row + 1 })}
      data-row={row}
      data-col={column}
      onChange={(event) => setHide(row, { [column]: event.target.value } as Partial<HideDraft>)}
      onKeyDown={(event) => onKey(event, row, column)}
      onPaste={(event) => onPaste(event, row, column)}
      {...extra}
    />
  )
  const measured = lot.hides.filter((hide) => Number(hide.area.replace(',', '.')) > 0)
  const sum = measured.reduce((total, hide) => total + Number(hide.area.replace(',', '.')), 0)
  const units = [...new Set(measured.map((hide) => hide.areaUom))]

  return (
    <div className="fw-by-stack">
      <div className="fw-by-sheet" ref={box} role="group" aria-label={t('rc.sheet.label', { n: lotIndex + 1 })}>
        <table>
          <thead>
            <tr>
              <th className="is-seq">#</th>
              <th className="is-wide">{t('rc.sheet.tannery')}</th>
              <th className="is-narrow">{t('rc.sheet.area')}</th>
              <th className="is-narrow">{t('rc.sheet.unit')}</th>
              <th className="is-tight">{t('rc.sheet.grade')}</th>
              <th className="is-narrow">{t('rc.sheet.thickness')}</th>
              <th className="is-tight">{t('rc.sheet.shade')}</th>
              <th className="is-wide">{t('rc.sheet.defects')}</th>
              <th className="is-end">
                <span className="fw-by-sr">{t('rc.sheet.remove')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {lot.hides.map((hide, row) => (
              <tr key={hide.key}>
                <td className="is-seq">{row + 1}</td>
                <td className="is-wide">{cell(hide, row, 'supplierCode', t('rc.sheet.tannery'), { maxLength: 60 })}</td>
                <td className="is-narrow">{cell(hide, row, 'area', t('rc.sheet.area'), { inputMode: 'decimal' })}</td>
                <td className="is-narrow">
                  <Select size="sm" aria-label={t('rc.sheet.cell', { field: t('rc.sheet.unit'), n: row + 1 })} value={hide.areaUom} onChange={(event) => setHide(row, { areaUom: event.target.value as Uom })}>
                    {HIDE_AREA_UNITS.map((option) => (
                      <option key={option} value={option}>
                        {t(`uom.${option}`)}
                      </option>
                    ))}
                  </Select>
                </td>
                <td className="is-tight">{cell(hide, row, 'grade', t('rc.sheet.grade'), { maxLength: 40 })}</td>
                <td className="is-narrow">{cell(hide, row, 'thicknessMm', t('rc.sheet.thickness'), { inputMode: 'decimal' })}</td>
                <td className="is-tight">{cell(hide, row, 'shade', t('rc.sheet.shade'), { maxLength: 60 })}</td>
                <td className="is-wide">{cell(hide, row, 'defects', t('rc.sheet.defects'), { maxLength: 1000 })}</td>
                <td className="is-end">
                  <Button size="sm" variant="quiet" onClick={() => onChange(lot.hides.filter((_, at) => at !== row))} aria-label={t('rc.sheet.removeHide', { n: row + 1 })}>
                    <Trash2 size={13} aria-hidden />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="fw-by-totals">
        <Button
          size="sm"
          onClick={() => {
            pending.current = { row: lot.hides.length, column: 'supplierCode' }
            onChange([...lot.hides, blankHide(line, unit)])
          }}
        >
          <Plus size={13} aria-hidden /> {t('rc.sheet.add')}
        </Button>
        <span className="fw-by-num">{units.length === 1 ? t('rc.sheet.sum', { count: measured.length, area: quantity(sum, locale), unit: t(`uom.${units[0]}`) }) : t('rc.sheet.sumMixed', { count: measured.length })}</span>
        <span className="fw-by-hint">{t('rc.sheet.keys', { columns: HIDE_COLUMNS.length })}</span>
      </div>
    </div>
  )
}

/** Posted: the receipt's number, its lots and where each stands, the notes in words. */
function Result({ model, actions }: { model: ReceiveModel; actions?: ReceiveActions }) {
  const t = useT('buying')
  const locale = useLocale()
  const result = model.result!
  const receipt = result.receipt
  const lots = receipt.lines.flatMap((line) => line.lots.map((lot) => ({ line, lot })))
  return (
    <div className="fw-by-stack" role="status">
      <Banner tone="success" title={t('rc.result.title', { number: receipt.number })}>
        {t('rc.result.body', { lines: receipt.summary.lines, lots: receipt.summary.lots, hides: receipt.summary.hides, quantity: receipt.summary.quantities.map((entry) => `${quantity(entry.baseQuantity, locale)} ${t(`uom.${entry.uom}`)}`).join(' · ') })}
      </Banner>
      <div className="fw-by-cards">
        <Card padded>
          <div className="fw-by-stack">
            <h3 className="fw-by-h3">{t('rc.result.lots')}</h3>
            {lots.length === 0 ? (
              <p className="fw-by-hint">{t('rc.noLots')}</p>
            ) : (
              <ul className="fw-by-checks">
                {lots.map(({ line, lot }) => (
                  <li key={lot.id} className="fw-by-check">
                    {lot.qualityStatus === 'RELEASED' ? <CheckCircle2 size={16} className="fw-by-ico is-ok" aria-hidden /> : <AlertTriangle size={16} className="fw-by-ico is-warning" aria-hidden />}
                    <span className="fw-by-check-body">
                      <b>
                        {lot.code} · {line.item.code}
                      </b>
                      <span className="fw-by-hint">{lot.qualityStatus === 'RELEASED' ? t('rc.lot.releasedAtReceipt') : lot.holds.map((hold) => t(`rc.hold.${hold}`)).join(' · ')}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>
        <Card padded>
          <div className="fw-by-stack">
            <h3 className="fw-by-h3">{t('rc.result.notes')}</h3>
            {result.notes.length === 0 ? (
              <p className="fw-by-hint">{t('rc.result.noNotes')}</p>
            ) : (
              <ul className="fw-by-list">
                {result.notes.map((note, index) => (
                  <li key={`${note.code}-${index}`}>{t(`rc.note.${note.code}`, { seq: note.seq ?? '—' })}</li>
                ))}
              </ul>
            )}
          </div>
        </Card>
      </div>
      <div className="fw-by-inline">
        <Button size="sm" variant="primary" asChild>
          <Link href={`${model.prefix}/warehouse/receipts/${receipt.id}`}>{t('rc.result.open')}</Link>
        </Button>
        <Button size="sm" asChild>
          <Link href={`${model.prefix}/warehouse/receipts/${receipt.id}?tab=lots`}>{t('rc.result.openLots')}</Link>
        </Button>
        {receipt.purchaseOrder && receipt.purchaseOrder.status === 'PARTLY_RECEIVED' && (
          <Button size="sm" onClick={() => actions?.onAnother?.()}>
            {t('rc.result.another', { number: receipt.purchaseOrder.number })}
          </Button>
        )}
        <Button size="sm" variant="quiet" asChild>
          <Link href={`${model.prefix}/warehouse/receipts`}>{t('rc.back')}</Link>
        </Button>
      </div>
    </div>
  )
}
