'use client'

import { useMemo, useState } from 'react'
import { CheckCircle2, PackageCheck, PauseCircle, Printer, Scissors, Unlock, XCircle } from 'lucide-react'
import { Banner, EmptyState, Field, Modal, SummaryTable } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { StepUpModal } from '@nexus/ui/patterns'
import { Button, Checkbox, Input, RadioCard, Select, Spinner, Tag, Textarea } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { wordsIn } from '../../../../_shared/reasons/model'
import type { PickList, WorkOrder, WorkOrderBundles } from '../../../_shared/api'
import { quantityText } from '../../../_shared/model'
import { SPLIT_REASONS, type SplitReason } from '../api'
import {
  cuttingRows,
  DAILY_NAMESPACE,
  finishRows,
  hideHeld,
  pickRows,
  placeHeld,
  releaseCheckPhrase,
  releaseHoldHeld,
  reportCells,
  reportHeld,
  splitAskHeld,
  type AvailableHide,
  type DailyActions,
  type DailyModel,
} from '../model'
import { say } from './DailyParts'
import '../daily.css'

/**
 * The work order's W2a dialogs (B-W2a-46; DS Modal: Esc closes, the focus returns to the opener): Put on hold (wo-hold:
 * a HOLD reason, the note it asks for; the floor refuses the work and shows the reason), Release the hold (the hold's
 * checks in words, the statement where the floor names stations, the office's step-up), Report finished to stock
 * (wo-finish: per size what can go now), Reserve leather (wo-leather "the Find hides dialog": the list frame of the
 * material's hides, a hide another demand holds or that is not released cannot be ticked, with why), Split bundle
 * (bd-split: garments into a child bundle with its own ticket) and Print (the pick list, the cutting list).
 */
export function DailyDialogs({ workOrder, daily, actions, pick, bundles }: { workOrder: WorkOrder; daily: DailyModel; actions?: DailyActions; pick: PickList | null; bundles: WorkOrderBundles | null }) {
  const t = useT(DAILY_NAMESPACE)
  const dialog = daily.dialog
  const step = (
    <StepUpModal
      open={daily.stepUp.open}
      title={t('stepUp.title')}
      sentence={daily.stepUp.sentence ? t(daily.stepUp.sentence) : ''}
      busy={daily.stepUp.busy}
      error={daily.stepUp.problem ? t(daily.stepUp.problem) : null}
      onSubmit={(code) => actions?.onStepUp?.(code)}
      onClose={() => actions?.onCancelStepUp?.()}
      confirmLabel={t('stepUp.confirm')}
    />
  )
  if (!dialog) return step
  return (
    <>
      {dialog.kind === 'hold' && <HoldDialog numbers={dialog.numbers} workOrderIds={dialog.workOrderIds} daily={daily} actions={actions} />}
      {dialog.kind === 'releaseHold' && <ReleaseHoldDialog holdId={dialog.holdId} daily={daily} actions={actions} />}
      {dialog.kind === 'finish' && <FinishDialog workOrder={workOrder} daily={daily} actions={actions} />}
      {dialog.kind === 'reserve' && <ReserveDialog workOrder={workOrder} itemId={dialog.itemId} itemColourId={dialog.itemColourId} daily={daily} actions={actions} />}
      {dialog.kind === 'split' && <SplitDialog bundleId={dialog.bundleId} bundles={bundles} daily={daily} actions={actions} />}
      {dialog.kind === 'print' && <PrintDialog what={dialog.what} workOrder={workOrder} pick={pick} bundles={bundles} actions={actions} />}
      {step}
    </>
  )
}

function Footer({ onCancel, children }: { onCancel: () => void; children?: React.ReactNode }) {
  const t = useT(DAILY_NAMESPACE)
  return (
    <>
      <span className="grow" />
      <Button size="sm" onClick={onCancel}>
        {t('common.cancel')}
      </Button>
      {children}
    </>
  )
}

function Problem({ daily }: { daily: DailyModel }) {
  const t = useT(DAILY_NAMESPACE)
  return daily.problem ? <Banner tone="danger" title={say(t, daily.problem) ?? ''} /> : null
}

/** ⌘↵ in a dialog's form runs its main action when it may go. */
const submitKeys = (go: (() => void) | null) => (event: React.KeyboardEvent) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && go) {
    event.preventDefault()
    go()
  }
}

// ---- Put on hold ----------------------------------------------------------------------------------------------------------------

export function HoldDialog({ numbers, workOrderIds, daily, actions }: { numbers: string[]; workOrderIds: string[]; daily: DailyModel; actions?: DailyActions }) {
  const t = useT(DAILY_NAMESPACE)
  const locale = useLocale()
  const [reasonCode, setReasonCode] = useState(daily.draft?.reasonCode ?? '')
  const [note, setNote] = useState(daily.draft?.note ?? '')
  const held = placeHeld(reasonCode, note, daily.reasons, daily.busy)
  const reason = daily.reasons?.find((entry) => entry.code === reasonCode) ?? null
  const go = held ? null : () => actions?.onPlaceHold?.({ workOrderIds, reasonCode, reasonNote: note.trim() || null })
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={numbers.length === 1 ? t('hold.title', { number: numbers[0]! }) : t('hold.titleMany', { count: numbers.length })}
      size="md"
      footer={
        <Footer onCancel={() => actions?.onDialog?.(null)}>
          <Button size="sm" variant="primary" heldReason={say(t, held)} onClick={() => go?.()} aria-keyshortcuts="Meta+Enter Control+Enter">
            {daily.busy ? <Spinner size={12} /> : <PauseCircle size={13} aria-hidden />} {numbers.length === 1 ? t('hold.go') : t('hold.goMany', { count: numbers.length })}
          </Button>
        </Footer>
      }
    >
      <form className="fw-pr-dialog" onSubmit={(event) => (event.preventDefault(), go?.())} onKeyDown={submitKeys(go)}>
        <Problem daily={daily} />
        <p>{t('hold.body')}</p>
        {numbers.length > 1 && <p className="fw-pr-hint">{numbers.join(' · ')}</p>}
        <Field label={t('hold.reason')}>
          {daily.reasons === null ? (
            <p className="fw-pr-hint" role="status">
              <Spinner size={12} /> {t('hold.reasonsLoading')}
            </p>
          ) : (
            <Select size="sm" value={reasonCode} onChange={(event) => setReasonCode(event.target.value)} aria-label={t('hold.reason')}>
              <option value="">{t('hold.reasonPick')}</option>
              {daily.reasons.map((entry) => (
                <option key={entry.code} value={entry.code}>
                  {wordsIn(entry, locale)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('hold.note')} hint={reason?.needsDetail ? t('hold.noteNeeded') : t('hold.noteHint')}>
          <Textarea value={note} onChange={(event) => setNote(event.target.value)} rows={3} maxLength={500} />
        </Field>
        <ul className="fw-pr-list">
          <li>{t('hold.floor')}</li>
          <li>{t('hold.releaseBy')}</li>
        </ul>
      </form>
    </Modal>
  )
}

// ---- Release the hold -----------------------------------------------------------------------------------------------------------

function ReleaseHoldDialog({ holdId, daily, actions }: { holdId: string; daily: DailyModel; actions?: DailyActions }) {
  const t = useT(DAILY_NAMESPACE)
  const [statement, setStatement] = useState(!!daily.draft?.statement)
  const [note, setNote] = useState(daily.draft?.note ?? '')
  const record = daily.holdRecord?.value ?? null
  const needsStatement = !!record?.release.checks.some((check) => check.key === 'STATEMENT')
  const held = releaseHoldHeld(record, daily.can, statement, needsStatement, daily.busy)
  const go = held || !record ? null : () => actions?.onReleaseHold?.({ holdId, version: record.hold.version, note: note.trim() || null, notMakerStatement: statement })
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={t('releaseHold.title')}
      size="md"
      footer={
        <Footer onCancel={() => actions?.onDialog?.(null)}>
          <Button size="sm" variant="primary" heldReason={say(t, held)} onClick={() => go?.()} aria-keyshortcuts="Meta+Enter Control+Enter">
            {daily.busy ? <Spinner size={12} /> : <Unlock size={13} aria-hidden />} {t('releaseHold.go')}
          </Button>
        </Footer>
      }
    >
      <form className="fw-pr-dialog" onSubmit={(event) => (event.preventDefault(), go?.())} onKeyDown={submitKeys(go)}>
        <Problem daily={daily} />
        {!record ? (
          daily.holdRecord?.problem ? (
            <EmptyState title={t('part.failed', { part: t('releaseHold.title') })} description={t(daily.holdRecord.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.('holdRecord')}>{t('common.retry')}</Button>} />
          ) : (
            <p className="fw-pr-hint" role="status">
              <Spinner size={12} /> {t('part.loading', { part: t('releaseHold.title') })}
            </p>
          )
        ) : (
          <>
            <p>{t('releaseHold.body')}</p>
            <ul className="fw-pr-checks" aria-label={t('releaseHold.checks')}>
              {record.release.checks.map((check) => (
                <li key={check.key} className="fw-pr-check">
                  {check.ok || (check.key === 'STATEMENT' && statement) ? <CheckCircle2 size={16} className="fw-pr-ico is-ok" aria-hidden /> : <XCircle size={16} className="fw-pr-ico is-blocked" aria-hidden />}
                  <span className="fw-pr-check-body">{say(t, releaseCheckPhrase(check.key, check.ok || (check.key === 'STATEMENT' && statement)))}</span>
                </li>
              ))}
            </ul>
            {needsStatement && <Checkbox checked={statement} onChange={(event) => setStatement(event.target.checked)} label={t('releaseHold.statement')} />}
            <Field label={t('releaseHold.note')} hint={t('releaseHold.noteHint')}>
              <Textarea value={note} onChange={(event) => setNote(event.target.value)} rows={2} maxLength={500} />
            </Field>
            <p className="fw-pr-hint">{t('releaseHold.stepUp')}</p>
          </>
        )}
      </form>
    </Modal>
  )
}

// ---- Report finished to stock -----------------------------------------------------------------------------------------------------

function FinishDialog({ workOrder, daily, actions }: { workOrder: WorkOrder; daily: DailyModel; actions?: DailyActions }) {
  const t = useT(DAILY_NAMESPACE)
  const finished = daily.finished?.value ?? null
  const [asked, setAsked] = useState<Record<string, number>>(daily.draft?.asked ?? {})
  const [placeId, setPlaceId] = useState<string>(daily.draft?.placeId ?? finished?.defaultLocationId ?? finished?.places[0]?.id ?? '')
  const [note, setNote] = useState(daily.draft?.note ?? '')
  const rows = useMemo(() => (finished ? finishRows(finished, asked) : []), [finished, asked])
  const total = rows.reduce((sum, row) => sum + (row.over ? 0 : row.asked), 0)
  const held = finished ? reportHeld(rows, placeId || null, daily.busy) : { key: 'held.loading' }
  const go = held ? null : () => actions?.onReport?.({ cells: reportCells(rows), toLocationId: placeId || null, note: note.trim() || null })
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={t('finish.title', { number: workOrder.number })}
      size="lg"
      footer={
        <Footer onCancel={() => actions?.onDialog?.(null)}>
          <Button size="sm" variant="primary" heldReason={say(t, held)} onClick={() => go?.()} aria-keyshortcuts="Meta+Enter Control+Enter">
            {daily.busy ? <Spinner size={12} /> : <PackageCheck size={13} aria-hidden />} {t('finish.go', { count: total })}
          </Button>
        </Footer>
      }
    >
      <form className="fw-pr-dialog" onSubmit={(event) => (event.preventDefault(), go?.())} onKeyDown={submitKeys(go)}>
        <Problem daily={daily} />
        <p>{t('finish.body')}</p>
        {finished && (
          <>
            <SummaryTable
              label={t('finish.cells')}
              stackOnPhone
              columns={[t('finish.col.cell'), t('finish.col.released'), t('finish.col.inStock'), t('finish.col.can'), t('finish.col.now')]}
              align={[undefined, 'right', 'right', 'right', 'right']}
              rows={rows.map((row) => ({
                id: row.cellId,
                cells: [
                  <span key="c" className="fw-pr-cell">
                    <span>
                      {row.colourwayCode} {row.size}
                    </span>
                    <span className="fw-pr-cell-sub">{row.sku ?? t('finish.noSku')}</span>
                  </span>,
                  String(row.netReleased),
                  String(row.inStock),
                  String(row.canReport),
                  <Input
                    key="q"
                    size="sm"
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={row.canReport}
                    value={String(row.asked)}
                    disabled={row.canReport === 0}
                    aria-label={t('finish.quantityLabel', { cell: `${row.colourwayCode} ${row.size}` })}
                    aria-invalid={row.over || undefined}
                    onChange={(event) => setAsked((current) => ({ ...current, [row.cellId]: event.target.value === '' ? 0 : Number(event.target.value) }))}
                  />,
                ],
              }))}
            />
            <Field label={t('finish.place')} hint={t('finish.placeHint', { site: finished.siteCode })}>
              <Select size="sm" value={placeId} onChange={(event) => setPlaceId(event.target.value)} aria-label={t('finish.place')}>
                {finished.places.length === 0 && <option value="">{t('finish.noPlace')}</option>}
                {finished.places.map((place) => (
                  <option key={place.id} value={place.id}>
                    {place.code} · {place.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('finish.note')}>
              <Textarea value={note} onChange={(event) => setNote(event.target.value)} rows={2} maxLength={500} />
            </Field>
            <p className="fw-pr-hint">{t(finished.tracking === 'SERIAL' ? 'finished.hintSerial' : 'finished.hint')}</p>
          </>
        )}
      </form>
    </Modal>
  )
}

// ---- Reserve leather: the Find hides dialog ------------------------------------------------------------------------------------

function ReserveDialog({ workOrder, itemId, itemColourId, daily, actions }: { workOrder: WorkOrder; itemId: string; itemColourId: string | null; daily: DailyModel; actions?: DailyActions }) {
  const t = useT(DAILY_NAMESPACE)
  const locale = useLocale()
  const [selected, setSelected] = useState<readonly string[]>(daily.draft?.picked ?? [])
  const material = workOrder.spec.materials.find((entry) => entry.itemId === itemId && (entry.itemColourId ?? null) === itemColourId) ?? null
  const availability = daily.availability?.value ?? null
  const hides = availability?.hides ?? null
  const free = (hides ?? []).filter((hide) => hideHeld(hide, workOrder.id) === null)
  const pickedArea = (hides ?? []).filter((hide) => selected.includes(hide.hide.id)).reduce((sum, hide) => sum + Number(hide.onHand), 0)
  const held = daily.busy ? t('held.busy') : selected.length === 0 ? t('reserve.held.none') : null
  const columns = useMemo<ColDef<AvailableHide>[]>(
    () => [
      { colId: 'hide', headerName: t('reserve.col.hide'), minWidth: 140, flex: 1, valueGetter: (params) => params.data?.hide.code ?? '' },
      { colId: 'area', headerName: t('reserve.col.area'), minWidth: 110, flex: 0.7, type: 'rightAligned', valueGetter: (params) => (params.data ? `${quantityText(params.data.onHand, locale)} ${availability?.item.baseUom ?? ''}` : '') },
      {
        colId: 'state',
        headerName: t('reserve.col.state'),
        minWidth: 180,
        flex: 1.2,
        cellRenderer: ({ data }: ICellRendererParams<AvailableHide>) => {
          if (!data) return null
          const why = hideHeld(data, workOrder.id)
          return why ? <Tag tone={why === 'reserve.why.mine' ? 'success' : 'warning'}>{t(why)}</Tag> : <Tag tone="info">{t('reserve.free')}</Tag>
        },
      },
    ],
    [t, locale, availability?.item.baseUom, workOrder.id],
  )
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={t('reserve.title', { material: material ? [material.itemCode, material.colourCode].filter(Boolean).join(' · ') : '—' })}
      size="lg"
      footer={
        <Footer onCancel={() => actions?.onDialog?.(null)}>
          <Button size="sm" variant="primary" heldReason={held} onClick={() => actions?.onReserve?.([...selected])}>
            {daily.busy ? <Spinner size={12} /> : null} {t('reserve.go', { count: selected.length })}
          </Button>
        </Footer>
      }
    >
      <div className="fw-pr-dialog">
        <Problem daily={daily} />
        <p>{t('reserve.body', { needed: material ? `${quantityText(material.balance, locale)} ${material.baseUom}` : '—' })}</p>
        <ListFrame<AvailableHide>
          label={t('reserve.tableLabel')}
          rows={daily.availability?.problem ? [] : hides}
          rowId={(row) => row.hide.id}
          columns={columns}
          count={hides ? t('reserve.count', { count: hides.length, free: free.length }) : '—'}
          selection={{
            selected,
            onChange: setSelected,
            actions: <SelectionLabel>{t('reserve.picked', { count: selected.length, area: quantityText(String(pickedArea), locale), uom: availability?.item.baseUom ?? '' })}</SelectionLabel>,
          }}
          isRowSelectable={(row) => {
            const why = hideHeld(row, workOrder.id)
            return why ? t(why) : null
          }}
          listKey={null}
          state={
            daily.availability?.problem ? (
              <EmptyState title={t('part.failed', { part: t('reserve.tableLabel') })} description={t(daily.availability.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.('availability')}>{t('common.retry')}</Button>} />
            ) : hides && hides.length === 0 ? (
              <EmptyState title={t('reserve.empty.title')} description={t('reserve.empty.body')} />
            ) : undefined
          }
        />
        <p className="fw-pr-hint">{t('reserve.hint')}</p>
      </div>
    </Modal>
  )
}

// ---- Split bundle -----------------------------------------------------------------------------------------------------------------

function SplitDialog({ bundleId, bundles, daily, actions }: { bundleId: string; bundles: WorkOrderBundles | null; daily: DailyModel; actions?: DailyActions }) {
  const t = useT(DAILY_NAMESPACE)
  const bundle = bundles?.bundles.find((entry) => entry.id === bundleId) ?? null
  const [quantity, setQuantity] = useState(String(daily.draft?.quantity ?? 1))
  const [reason, setReason] = useState<SplitReason | ''>(daily.draft?.splitReason ?? '')
  const [note, setNote] = useState(daily.draft?.note ?? '')
  const held = bundle ? splitAskHeld(Number(quantity), bundle, reason, daily.busy) : { key: 'held.loading' }
  const go = held || !bundle || !reason ? null : () => actions?.onSplit?.({ bundleId, quantity: Number(quantity), reason, note: note.trim() || null })
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={t('split.title', { code: bundle?.code ?? '—' })}
      size="md"
      footer={
        <Footer onCancel={() => actions?.onDialog?.(null)}>
          <Button size="sm" variant="primary" heldReason={say(t, held)} onClick={() => go?.()} aria-keyshortcuts="Meta+Enter Control+Enter">
            {daily.busy ? <Spinner size={12} /> : <Scissors size={13} aria-hidden />} {t('split.go')}
          </Button>
        </Footer>
      }
    >
      <form className="fw-pr-dialog" onSubmit={(event) => (event.preventDefault(), go?.())} onKeyDown={submitKeys(go)}>
        <Problem daily={daily} />
        {bundle && <p>{t('split.body', { code: bundle.code, quantity: bundle.quantity, cell: `${bundle.colourwayCode} ${bundle.size}` })}</p>}
        <Field label={t('split.quantity')} hint={bundle ? t('split.quantityHint', { max: bundle.quantity - 1 }) : undefined}>
          <Input size="sm" type="number" inputMode="numeric" min={1} max={bundle ? bundle.quantity - 1 : 1} value={quantity} onChange={(event) => setQuantity(event.target.value)} />
        </Field>
        <fieldset className="fw-wd-choices">
          <legend className="fw-pr-h3">{t('split.reason')}</legend>
          {SPLIT_REASONS.map((value) => (
            <RadioCard key={value} variant="row" name="fw-wd-split-reason" value={value} checked={reason === value} selected={reason === value} onChange={() => setReason(value)} title={t(`split.reasons.${value}`)} description={t(`split.reasons.${value}Hint`)} />
          ))}
        </fieldset>
        <Field label={t('split.note')}>
          <Textarea value={note} onChange={(event) => setNote(event.target.value)} rows={2} maxLength={200} />
        </Field>
        <p className="fw-pr-hint">{t('split.ticket')}</p>
      </form>
    </Modal>
  )
}

// ---- Print: the pick list, the cutting list ------------------------------------------------------------------------------------

function PrintDialog({ what, workOrder, pick, bundles, actions }: { what: 'pick' | 'cutting'; workOrder: WorkOrder; pick: PickList | null; bundles: WorkOrderBundles | null; actions?: DailyActions }) {
  const t = useT(DAILY_NAMESPACE)
  const locale = useLocale()
  const picks = pickRows(pick)
  const cuts = cuttingRows(workOrder, bundles)
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={t(`print.${what}.title`, { number: workOrder.number })}
      size="lg"
      footer={
        <Footer onCancel={() => actions?.onDialog?.(null)}>
          <Button size="sm" variant="primary" heldReason={what === 'pick' && !pick ? t('held.loading') : null} onClick={() => window.print()}>
            <Printer size={13} aria-hidden /> {t('print.go')}
          </Button>
        </Footer>
      }
    >
      <div className="fw-wd-print">
        <h2 className="fw-pr-h2">
          {t(`print.${what}.heading`)} · {workOrder.number}
          {workOrder.batchNumber ? ` · ${workOrder.batchNumber}` : ''}
        </h2>
        <p className="fw-pr-hint">
          {workOrder.style.code} {workOrder.style.name} · {workOrder.site.code}
        </p>
        {what === 'pick' ? (
          picks.length === 0 ? (
            <p className="fw-pr-hint">{t('print.pick.none')}</p>
          ) : (
            <SummaryTable
              label={t('print.pick.heading')}
              columns={[t('print.col.material'), t('print.col.toIssue'), t('print.col.from')]}
              align={[undefined, 'right', undefined]}
              rows={picks.map((row, index) => ({ id: String(index), cells: [row.material, `${quantityText(row.toIssue, locale)} ${row.uom}`, row.from] }))}
            />
          )
        ) : (
          <SummaryTable
            label={t('print.cutting.heading')}
            columns={[t('print.col.cell'), t('print.col.garments'), t('print.col.parts')]}
            align={[undefined, 'right', undefined]}
            rows={cuts.map((row, index) => ({ id: String(index), cells: [row.cell, String(row.quantity), row.parts] }))}
          />
        )}
        <p className="fw-pr-hint">{t(`print.${what}.foot`)}</p>
      </div>
    </Modal>
  )
}
